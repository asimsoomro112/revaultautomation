/**
 * lib/storage.ts tests — Cloudinary SDK is fully mocked (never hits network).
 * Covers: public_id mapping, upload guards (timeout/content-type/size),
 * signed URL generation (private_download_url + 4h expires_at), destroy and
 * bulk prefix delete, and the requireCloudinaryEnv guard.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  upload_stream: vi.fn(),
  destroy: vi.fn(),
  delete_resources_by_prefix: vi.fn(),
  private_download_url: vi.fn(),
}));

vi.mock("cloudinary", () => ({
  v2: {
    config: mocks.config,
    uploader: { upload_stream: mocks.upload_stream, destroy: mocks.destroy },
    api: { delete_resources_by_prefix: mocks.delete_resources_by_prefix },
    utils: { private_download_url: mocks.private_download_url },
  },
}));

import { resetEnvCache } from "./env";
import {
  deletePath,
  deletePrefix,
  downloadBytes,
  downloadImageToStorage,
  resetCloudinaryConfigForTests,
  signedReadUrl,
  toPublicId,
} from "./storage";
import { requireCloudinaryEnv } from "./env";

const CLOUD_VARS = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const;

function setCloudEnv() {
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  resetEnvCache();
  resetCloudinaryConfigForTests();
}

function clearCloudEnv() {
  for (const k of CLOUD_VARS) delete process.env[k];
  resetEnvCache();
  resetCloudinaryConfigForTests();
}

/** Minimal ReadableStream of byte chunks for fetch body mocks. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

function imageResponse(bytes: number, contentType = "image/jpeg") {
  return {
    ok: true,
    headers: new Headers({ "content-type": contentType }),
    body: streamOf([new Uint8Array(bytes)]),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  setCloudEnv();
  // Default happy-path SDK behaviour.
  mocks.upload_stream.mockImplementation((_opts: unknown, cb: (err: unknown, res: unknown) => void) => {
    cb(null, { public_id: "revault/listings/raw/lst_1/m_1" });
    return { end: vi.fn() };
  });
  mocks.destroy.mockResolvedValue({ result: "ok" });
  mocks.delete_resources_by_prefix.mockResolvedValue({ deleted: {} });
  mocks.private_download_url.mockReturnValue("https://api.cloudinary.com/signed-url");
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCloudEnv();
});

describe("toPublicId", () => {
  it("maps a logical path under revault/listings without the extension", () => {
    expect(toPublicId("raw/lst_abc/m_1.jpg")).toBe("revault/listings/raw/lst_abc/m_1");
    expect(toPublicId("slides/lst_abc/0.jpg")).toBe("revault/listings/slides/lst_abc/0");
  });
  it("strips a leading slash", () => {
    expect(toPublicId("/raw/lst_abc/m_1.jpg")).toBe("revault/listings/raw/lst_abc/m_1");
  });
});

describe("downloadImageToStorage", () => {
  it("downloads then signed-uploads as a private asset with deterministic public_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(1024));
    vi.stubGlobal("fetch", fetchMock);
    const { bytes } = await downloadImageToStorage("https://cdn.meta/x.jpg?token=abc", "raw/lst_1/m_1.jpg");
    expect(bytes).toBe(1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.upload_stream).toHaveBeenCalledTimes(1);
    const opts = mocks.upload_stream.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.public_id).toBe("revault/listings/raw/lst_1/m_1");
    expect(opts.resource_type).toBe("image");
    expect(opts.type).toBe("private");
    expect(opts.overwrite).toBe(true);
    // api_secret is only used via config(), never passed per-call.
    expect(JSON.stringify(opts)).not.toContain("test-secret");
  });

  it("refuses non-image content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse(100, "text/html")));
    await expect(downloadImageToStorage("https://cdn.meta/x", "raw/lst_1/m_1.jpg")).rejects.toThrow(
      /non-image/,
    );
    expect(mocks.upload_stream).not.toHaveBeenCalled();
  });

  it("refuses oversized downloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse(16 * 1024 * 1024)));
    await expect(downloadImageToStorage("https://cdn.meta/x", "raw/lst_1/m_1.jpg")).rejects.toThrow(
      /exceeds/,
    );
    expect(mocks.upload_stream).not.toHaveBeenCalled();
  });

  it("throws on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() }),
    );
    await expect(downloadImageToStorage("https://cdn.meta/x", "raw/lst_1/m_1.jpg")).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("propagates upload failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse(512)));
    mocks.upload_stream.mockImplementation((_opts: unknown, cb: (err: unknown, res: unknown) => void) => {
      cb(new Error("boom"), null);
      return { end: vi.fn() };
    });
    await expect(downloadImageToStorage("https://cdn.meta/x", "raw/lst_1/m_1.jpg")).rejects.toThrow(
      /boom/,
    );
  });
});

describe("signedReadUrl", () => {
  it("generates a time-limited private download URL (~4h default), never persisting it", async () => {
    const before = Math.floor(Date.now() / 1000);
    const url = await signedReadUrl("slides/lst_1/0.jpg");
    expect(url).toBe("https://api.cloudinary.com/signed-url");
    expect(mocks.private_download_url).toHaveBeenCalledTimes(1);
    const [publicId, format, opts] = mocks.private_download_url.mock.calls[0] as unknown as [
      string,
      string,
      { resource_type: string; type: string; expires_at: number },
    ];
    expect(publicId).toBe("revault/listings/slides/lst_1/0");
    expect(format).toBe("jpg");
    expect(opts.resource_type).toBe("image");
    expect(opts.type).toBe("private");
    // ~4h expiry (allow a few seconds of clock skew).
    expect(opts.expires_at).toBeGreaterThanOrEqual(before + 4 * 3600 - 10);
    expect(opts.expires_at).toBeLessThanOrEqual(before + 4 * 3600 + 10);
  });

  it("honours a custom TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    await signedReadUrl("raw/lst_1/m_1.jpg", 1);
    const opts = mocks.private_download_url.mock.calls[0]![2] as { expires_at: number };
    expect(opts.expires_at).toBeGreaterThanOrEqual(before + 3600 - 10);
    expect(opts.expires_at).toBeLessThanOrEqual(before + 3600 + 10);
  });
});

describe("downloadBytes", () => {
  it("fetches the private asset server-side via a short-lived signed URL", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => data.buffer as ArrayBuffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const buf = await downloadBytes("raw/lst_1/m_1.jpg");
    expect(Buffer.from(buf).equals(Buffer.from(data))).toBe(true);
    expect(mocks.private_download_url).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.cloudinary.com/signed-url");
  });

  it("throws on failed fetches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(downloadBytes("raw/lst_1/m_1.jpg")).rejects.toThrow(/HTTP 403/);
  });
});

describe("deletePath / deletePrefix", () => {
  it("destroys a single private asset (missing assets are a no-op)", async () => {
    await deletePath("raw/lst_1/m_1.jpg");
    expect(mocks.destroy).toHaveBeenCalledWith("revault/listings/raw/lst_1/m_1", {
      resource_type: "image",
      type: "private",
      invalidate: true,
    });
  });

  it("bulk-deletes by logical prefix for the retention cron", async () => {
    await deletePrefix("raw/lst_1/");
    expect(mocks.delete_resources_by_prefix).toHaveBeenCalledWith("revault/listings/raw/lst_1/", {
      resource_type: "image",
      type: "private",
    });
  });
});

describe("requireCloudinaryEnv", () => {
  it("throws naming the missing vars", () => {
    clearCloudEnv();
    expect(() => requireCloudinaryEnv()).toThrow(/CLOUDINARY_CLOUD_NAME/);
    process.env.CLOUDINARY_CLOUD_NAME = "x";
    resetEnvCache();
    expect(() => requireCloudinaryEnv()).toThrow(/CLOUDINARY_API_KEY/);
  });

  it("passes when all three are set", () => {
    setCloudEnv();
    expect(() => requireCloudinaryEnv()).not.toThrow();
  });
});
