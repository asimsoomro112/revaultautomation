/**
 * Cloudinary media storage — PHOTO STORAGE ONLY.
 *
 * Firestore stays the database, Firebase Auth stays the admin login.
 * Cloudinary is purely the photo store (free tier: 25 pooled credits/month;
 * 1 credit = 1GB storage OR 1GB bandwidth OR 1000 transformations).
 *
 * Logical paths (e.g. raw/{listingId}/{photoId}.jpg, slides/{listingId}/{n}.jpg)
 * map to Cloudinary public_ids: revault/listings/<path-without-extension>.
 * Assets upload as `type: 'private'` — nothing is publicly reachable; every
 * read goes through a server-generated time-limited signed URL.
 *
 * - downloadImageToStorage(url, destPath): fetch a Meta CDN URL NOW (CDN URLs
 *   expire — never persist them), then SIGNED-upload the bytes to Cloudinary.
 * - uploadBytes(path, data, contentType): signed server-side upload of
 *   processed bytes (the sharp slides from lib/images.ts).
 * - downloadBytes(path): server-side fetch of the private asset (dHash
 *   duplicate detection + Gemini vision need raw bytes).
 * - signedReadUrl(path, hours=4): time-limited signed download URL
 *   (private_download_url, expires_at = now + hours). Generated on demand,
 *   never persisted. Meta's servers fetch this for container creation; the
 *   /admin UI uses it for photo previews.
 * - deletePath(path): destroy one asset (missing assets are a no-op).
 * - deletePrefix(prefix): bulk delete for the retention cron.
 *
 * api_secret never leaves the server: config + signing happen in this module
 * only, lazily at first use, so `next build` and unit tests stay
 * credential-free. Tests mock the `cloudinary` SDK (never hit network).
 */
import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from "cloudinary";
import { requireCloudinaryEnv } from "./env";

const CLOUDINARY_ROOT = "revault/listings";
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_BYTES = 15 * 1024 * 1024; // 15MB cap

let configured = false;

/** Lazily configure the SDK from env (throws a clear error when creds are missing). */
function cld() {
  if (!configured) {
    const env = requireCloudinaryEnv(); // throws naming the missing var
    // Narrow for exactOptionalPropertyTypes: ConfigOptions takes string, not string|undefined.
    const { CLOUDINARY_CLOUD_NAME: cloud_name, CLOUDINARY_API_KEY: api_key, CLOUDINARY_API_SECRET: api_secret } = env;
    if (!cloud_name || !api_key || !api_secret) {
      throw new Error("Missing required env vars for Cloudinary: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
    }
    cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
    configured = true;
  }
  return cloudinary;
}

/** Test-only: reset lazy SDK config so tests can reconfigure. */
export function resetCloudinaryConfigForTests(): void {
  configured = false;
}

/**
 * Logical storage path -> Cloudinary public_id. `raw/lst_abc/m_1.jpg`
 * becomes `revault/listings/raw/lst_abc/m_1` (slashes act as folders;
 * Cloudinary stores the format separately).
 */
export function toPublicId(path: string): string {
  const noExt = path.replace(/\.[a-zA-Z0-9]+$/, "");
  const clean = noExt.replace(/^\/+/, "");
  return `${CLOUDINARY_ROOT}/${clean}`;
}

/** Format for delivery URLs, derived from the logical path's extension. */
function formatFor(path: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  return (m?.[1] ?? "jpg").toLowerCase();
}

function uploadBuffer(buffer: Buffer, opts: UploadApiOptions): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cld().uploader.upload_stream(opts, (err, res) => {
      if (err || !res) reject(err ?? new Error("cloudinary upload failed"));
      else resolve(res);
    });
    stream.end(buffer);
  });
}

/** Signed server-side upload of `data` to the private asset at `path`. */
export async function uploadBytes(path: string, data: Buffer, contentType: string): Promise<void> {
  const publicId = toPublicId(path);
  await uploadBuffer(data, {
    public_id: publicId,
    resource_type: "image",
    type: "private",
    overwrite: true,
    invalidate: true,
    unique_filename: false,
    use_filename: false,
    format: formatFor(path),
  });
  void contentType; // kept in the signature for caller compatibility; Cloudinary sniffs the bytes
}

/**
 * Download `url` into Cloudinary at `destPath`. Throws on timeout, HTTP error,
 * non-image content, or >15MB. Same contract as the old Firebase implementation.
 */
export async function downloadImageToStorage(url: string, destPath: string): Promise<{ bytes: number }> {
  const buffer = await fetchImageBytes(url);
  await uploadBytes(destPath, buffer, "image/jpeg");
  return { bytes: buffer.byteLength };
}

/** Fetch an image URL with timeout / content-type / size guards. */
async function fetchImageBytes(url: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`image download failed: HTTP ${res.status} for ${redactUrl(url)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`refusing non-image content-type '${contentType}' for ${redactUrl(url)}`);
    }
    if (!res.body) throw new Error(`empty response body for ${redactUrl(url)}`);

    // Stream with an enforced size cap — never buffer unbounded input.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`image exceeds ${MAX_BYTES} byte cap (${redactUrl(url)})`);
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error(`zero-byte image for ${redactUrl(url)}`);
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Time-limited signed URL for a private asset, via Cloudinary's documented
 * `private_download_url` (expires_at is a UNIX timestamp in seconds).
 * Generated on demand — never persisted. Default 4h (Meta container TTL rule).
 *
 * Note: this is an API-endpoint URL (not the CDN), so Cloudinary counts
 * roughly 2x bandwidth per fetch vs a signed delivery URL. Volumes here are
 * tiny (a few hundred KB per photo, fetched once by Meta per container), so
 * the cost is negligible — and it is the only documented mechanism with a
 * real expiry for private assets (plain signed delivery URLs don't expire).
 */
export async function signedReadUrl(path: string, hours = 4): Promise<string> {
  const publicId = toPublicId(path);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const url = cld().utils.private_download_url(publicId, formatFor(path), {
    resource_type: "image",
    type: "private",
    expires_at: expiresAt,
  });
  if (!url) throw new Error(`failed to sign URL for ${path}`);
  return url;
}

/** Server-side fetch of a private asset's raw bytes (dHash, Gemini vision). */
export async function downloadBytes(path: string): Promise<Buffer> {
  // Short-lived internal URL (10 min) — generated server-side, never exposed.
  const url = await signedReadUrl(path, 10 / 60);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`cloudinary download failed: HTTP ${res.status} for ${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error(`zero-byte asset for ${path}`);
  if (buf.byteLength > MAX_BYTES) throw new Error(`asset exceeds ${MAX_BYTES} byte cap (${path})`);
  return buf;
}

/** Delete one asset; missing assets are a no-op (destroy → 'not found'). */
export async function deletePath(path: string): Promise<void> {
  await cld().uploader.destroy(toPublicId(path), {
    resource_type: "image",
    type: "private",
    invalidate: true,
  });
}

/** Bulk delete every asset under a logical prefix (retention cron). */
export async function deletePrefix(prefix: string): Promise<void> {
  const clean = prefix.replace(/^\/+/, "");
  await cld().api.delete_resources_by_prefix(`${CLOUDINARY_ROOT}/${clean}`, {
    resource_type: "image",
    type: "private",
  });
}

/** Never log full CDN URLs (they carry query-string tokens). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
