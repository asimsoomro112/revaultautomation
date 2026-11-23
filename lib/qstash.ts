/**
 * Upstash QStash client + worker plumbing (Phase 1).
 *
 * - getQStashClient: lazy singleton (requireQStashEnv).
 * - enqueueWorker: publish a WorkerPayload to /api/workers/<route>
 *   with optional delaySec / notBefore (unix seconds) / deduplicationId.
 * - verifyQStashSignature(req): verify the Upstash signature over the RAW
 *   body text via the Receiver (current + next signing keys for rotation).
 *   Reads from a CLONE, so the route can still call req.json() afterwards.
 *   Never throws — returns false on any failure.
 */
import { Client, Receiver } from "@upstash/qstash";
import { getEnv, requireQStashEnv } from "./env";
import { log } from "./log";
import type { WorkerKind, WorkerPayload } from "./types";

let client: Client | null = null;
let receiver: Receiver | null = null;

/** Lazy QStash client. Throws (clear error) when QStash env is missing. */
export function getQStashClient(): Client {
  if (!client) {
    const env = requireQStashEnv();
    client = new Client({
      token: env.QSTASH_TOKEN as string,
      ...(env.QSTASH_URL ? { baseUrl: env.QSTASH_URL } : {}),
    });
  }
  return client;
}

export interface EnqueueOpts {
  /** Delay delivery by N seconds. */
  delaySec?: number;
  /** Deliver no earlier than this unix timestamp (seconds). */
  notBefore?: number;
  /** Idempotency key — QStash suppresses duplicate deliveries. */
  deduplicationId?: string;
}

/** Lazy Receiver singleton. nextSigningKey is required by the SDK types, so fall back to current. */
function getReceiver(): Receiver {
  if (!receiver) {
    const env = requireQStashEnv();
    const current = env.QSTASH_CURRENT_SIGNING_KEY as string;
    const next = (env.QSTASH_NEXT_SIGNING_KEY as string | undefined) || current;
    receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return receiver;
}

/** Public base URL (no trailing slash) — the same host QStash was told to call. */
function appBaseUrl(): string {
  return getEnv().APP_BASE_URL.replace(/\/$/, "");
}

/**
 * Verify a QStash delivery from raw parts (body must be the exact raw text).
 * Exported so route handlers can read the body once and verify + parse it.
 * `url` must be the PUBLIC url QStash called (APP_BASE_URL + path), not an internal proxy url.
 */
export async function verifyQStashSignatureRaw(args: {
  signature: string | null;
  body: string;
  url: string;
}): Promise<boolean> {
  try {
    if (!args.signature) return false;
    return await getReceiver().verify({
      signature: args.signature,
      body: args.body,
      url: args.url,
    });
  } catch (err) {
    log.warn("qstash signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Verify an incoming worker request.
 * Uses req.clone() so the original body stays readable for req.json() in the route.
 */
export async function verifyQStashSignature(req: Request): Promise<boolean> {
  try {
    const signature = req.headers.get("upstash-signature");
    const body = await req.clone().text();
    // Behind Vercel/ngrok/proxies req.url can differ (http vs https, host) from
    // what QStash signed — rebuild it from APP_BASE_URL.
    const { pathname, search } = new URL(req.url);
    const url = `${appBaseUrl()}${pathname}${search}`;
    return await verifyQStashSignatureRaw({ signature, body, url });
  } catch (err) {
    log.warn("qstash signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Verify a QStash delivery when the route already read the raw body text.
 * Rebuilds the signed URL from APP_BASE_URL — the same rule as
 * verifyQStashSignature: req.url can differ behind Vercel/proxies (http vs
 * https, host), and verifying against it silently 401s the worker.
 * QStash does not retry 4xx, so the job is LOST with only a warn log and
 * no error — exactly the silent-drop signature. All worker routes must use
 * this (or verifyQStashSignature), never verifyQStashSignatureRaw with
 * req.url directly.
 */
export async function verifyQStashSignatureWithBody(req: Request, rawText: string): Promise<boolean> {
  try {
    // Behind Vercel/ngrok/proxies req.url can differ (http vs https, host)
    // from what QStash signed — rebuild it from APP_BASE_URL.
    const { pathname, search } = new URL(req.url);
    const url = `${appBaseUrl()}${pathname}${search}`;
    return await verifyQStashSignatureRaw({
      signature: req.headers.get("upstash-signature"),
      body: rawText,
      url,
    });
  } catch (err) {
    log.warn("qstash signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Enqueue a worker invocation. Target URL is ${APP_BASE_URL}/api/workers/<route>. */
export async function enqueueWorker(
  route: WorkerKind,
  payload: WorkerPayload,
  opts: EnqueueOpts = {},
): Promise<void> {
  const url = `${appBaseUrl()}/api/workers/${route}`;
  // QStash rejects deduplicationIds containing ':' (HTTP 400) — sanitize
  // once here so every caller is safe (finalize ISO timestamps, "x:y" keys).
  const deduplicationId = opts.deduplicationId?.replace(/[^a-zA-Z0-9._-]/g, "-");
  const res = await getQStashClient().publishJSON({
    url,
    body: payload,
    ...(opts.delaySec !== undefined ? { delay: opts.delaySec } : {}),
    ...(opts.notBefore !== undefined ? { notBefore: opts.notBefore } : {}),
    ...(deduplicationId !== undefined ? { deduplicationId } : {}),
  });
  log.info("qstash enqueued", { route, messageId: res.messageId });
}
