/**
 * Token helper tests — AES-256-GCM roundtrip, wrong-key failure, store,
 * refresh gating (≥24h), and the short-lived exchange request shape.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: {},
  getAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
}));

import { getAdminSettings, updateAdminSettings } from "@/lib/firebase-admin";
import { decryptToken, encryptToken, exchangeShortLivedToken, refreshLongLivedToken, storeToken } from "./tokens";
import { resetEnvCache } from "./env";

const KEY_A = Buffer.alloc(32, 7).toString("hex");
const KEY_B = Buffer.alloc(32, 9).toString("hex");

function setKey(key: string) {
  process.env.IG_TOKEN_ENC_KEY = key;
  process.env.IG_APP_ID = "test-app-id";
  process.env.IG_APP_SECRET = "test-app-secret";
  process.env.IG_USER_ID = "17841400000000001";
  process.env.IG_API_BASE = "https://graph.instagram.com";
  resetEnvCache();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setKey(KEY_A);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encrypt/decrypt", () => {
  it("roundtrips", () => {
    const { enc, iv } = encryptToken("super-secret-token");
    expect(decryptToken(enc, iv)).toBe("super-secret-token");
  });

  it("uses a fresh IV per encryption", () => {
    const a = encryptToken("x");
    const b = encryptToken("x");
    expect(a.iv).not.toBe(b.iv);
    expect(a.enc).not.toBe(b.enc);
  });

  it("wrong key fails", () => {
    const { enc, iv } = encryptToken("super-secret-token");
    setKey(KEY_B);
    expect(() => decryptToken(enc, iv)).toThrow();
  });

  it("tampered ciphertext fails", () => {
    const { enc, iv } = encryptToken("super-secret-token");
    const raw = Buffer.from(enc, "base64");
    raw[0] = raw[0]! ^ 0xff;
    expect(() => decryptToken(raw.toString("base64"), iv)).toThrow();
  });

  it("missing key throws a clear error", () => {
    delete process.env.IG_TOKEN_ENC_KEY;
    resetEnvCache();
    expect(() => encryptToken("x")).toThrow(/IG_TOKEN_ENC_KEY/);
  });
});

describe("storeToken", () => {
  it("writes encrypted token + expiry + health", async () => {
    const expiresAt = new Date("2026-11-29T00:00:00Z");
    await storeToken("plain-token", expiresAt);
    expect(updateAdminSettings).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(updateAdminSettings).mock.calls[0]![0] as {
      token: { enc: string; iv: string; expires_at: string; updated_at: string };
      token_health: string;
    };
    expect(arg.token.expires_at).toBe("2026-11-29T00:00:00.000Z");
    expect(arg.token_health).toBe("ok");
    expect(typeof arg.token.updated_at).toBe("string");
    // Ciphertext decrypts back to the plaintext with the same key.
    expect(decryptToken(arg.token.enc, arg.token.iv)).toBe("plain-token");
    // Ciphertext is not the plaintext.
    expect(arg.token.enc).not.toContain("plain-token");
  });
});

describe("refreshLongLivedToken", () => {
  const oldStored = (updated_at: string) => {
    const { enc, iv } = encryptToken("old-long-lived");
    return { token: { enc, iv, expires_at: "2026-11-29T00:00:00.000Z", updated_at } };
  };

  it("returns { ok: false } when no token is stored (no fetch)", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue({ token: null } as never);
    await expect(refreshLongLivedToken()).resolves.toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns { ok: false } when the token is younger than 24h (no fetch)", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue(
      oldStored(new Date(Date.now() - 2 * 3600_000).toISOString()) as never,
    );
    await expect(refreshLongLivedToken()).resolves.toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes + stores when the token is ≥ 24h old", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue(
      oldStored(new Date(Date.now() - 30 * 3600_000).toISOString()) as never,
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "new-token", expires_in: 5184000, token_type: "bearer" }),
    });
    const res = await refreshLongLivedToken();
    expect(res.ok).toBe(true);
    expect(typeof res.expires_at).toBe("string");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/refresh_access_token?grant_type=ig_refresh_token");
    expect(url).toContain(`access_token=${encodeURIComponent("old-long-lived")}`);
    // Stored value decrypts to the NEW token.
    const stored = vi.mocked(updateAdminSettings).mock.calls[0]![0] as {
      token: { enc: string; iv: string };
    };
    expect(decryptToken(stored.token.enc, stored.token.iv)).toBe("new-token");
  });

  it("throws on Meta errors (caller alerts)", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue(
      oldStored(new Date(Date.now() - 30 * 3600_000).toISOString()) as never,
    );
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });
    await expect(refreshLongLivedToken()).rejects.toThrow(/refresh_access_token failed/);
  });
});

describe("exchangeShortLivedToken", () => {
  it("hits the documented endpoint and returns token + expires_in", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "long-lived", expires_in: 5184000 }),
    });
    const res = await exchangeShortLivedToken("short-lived-xyz");
    expect(res).toEqual({ token: "long-lived", expires_in: 5184000 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/access_token?grant_type=ig_exchange_token");
    expect(url).toContain("client_secret=test-app-secret");
    expect(url).toContain("access_token=short-lived-xyz");
  });
});
