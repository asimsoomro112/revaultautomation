/**
 * Phase 1 — QStash signature verification tests.
 *
 * The Receiver verifies an HS256 JWT (iss=Upstash, keyed by the signing key)
 * whose payload carries body=base64url(sha256(raw body)) and sub=url. These
 * tests hand-craft such JWTs with node:crypto (known vectors) and assert
 * verifyQStashSignatureRaw accepts/rejects them — no network, no Upstash.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getEnv } from "./env";
import { verifyQStashSignature, verifyQStashSignatureRaw } from "./qstash";

const URL = "http://localhost:3000/api/workers/ingest";
const BODY = JSON.stringify({ kind: "ingest", message: { mid: "m_123" } });

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Hand-craft a QStash-style signature JWT (HS256, iss=Upstash). */
function signJwt(opts: {
  key: string;
  body: string;
  url: string;
  expOffsetSec?: number;
}): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: "Upstash",
        sub: opts.url,
        body: b64url(createHash("sha256").update(opts.body).digest()),
        iat: now,
        exp: now + (opts.expOffsetSec ?? 3600),
      }),
    ),
  );
  const sig = b64url(createHmac("sha256", opts.key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function keys() {
  const env = getEnv();
  return {
    current: env.QSTASH_CURRENT_SIGNING_KEY as string,
    next: env.QSTASH_NEXT_SIGNING_KEY as string,
  };
}

describe("verifyQStashSignatureRaw", () => {
  it("accepts a valid signature from the current key", async () => {
    const { current } = keys();
    const sig = signJwt({ key: current, body: BODY, url: URL });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY, url: URL })).resolves.toBe(true);
  });

  it("accepts a valid signature from the next key (rotation)", async () => {
    const { next } = keys();
    const sig = signJwt({ key: next, body: BODY, url: URL });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY, url: URL })).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const { current } = keys();
    const sig = signJwt({ key: current, body: BODY, url: URL });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY + "x", url: URL })).resolves.toBe(false);
  });

  it("rejects a signature made with an unknown key", async () => {
    const sig = signJwt({ key: "not_a_real_key", body: BODY, url: URL });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY, url: URL })).resolves.toBe(false);
  });

  it("rejects a signature for a different url", async () => {
    const { current } = keys();
    const sig = signJwt({ key: current, body: BODY, url: "http://localhost:3000/api/workers/publish" });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY, url: URL })).resolves.toBe(false);
  });

  it("rejects an expired JWT", async () => {
    const { current } = keys();
    const sig = signJwt({ key: current, body: BODY, url: URL, expOffsetSec: -3600 });
    await expect(verifyQStashSignatureRaw({ signature: sig, body: BODY, url: URL })).resolves.toBe(false);
  });

  it("rejects a missing signature", async () => {
    await expect(verifyQStashSignatureRaw({ signature: null, body: BODY, url: URL })).resolves.toBe(false);
  });

  it("rejects garbage", async () => {
    await expect(verifyQStashSignatureRaw({ signature: "not-a-jwt", body: BODY, url: URL })).resolves.toBe(false);
  });

  it("never throws", async () => {
    await expect(verifyQStashSignatureRaw({ signature: null, body: "", url: "" })).resolves.toBe(false);
  });
});

describe("verifyQStashSignature(req)", () => {
  it("verifies a Request object end-to-end", async () => {
    const { current } = keys();
    const sig = signJwt({ key: current, body: BODY, url: URL });
    const req = new Request(URL, {
      method: "POST",
      headers: { "upstash-signature": sig, "content-type": "application/json" },
      body: BODY,
    });
    await expect(verifyQStashSignature(req)).resolves.toBe(true);
  });

  it("returns false when the signature header is absent", async () => {
    const req = new Request(URL, { method: "POST", body: BODY });
    await expect(verifyQStashSignature(req)).resolves.toBe(false);
  });
});
