/**
 * Instagram long-lived token management — Phase 5.
 *
 * NOTE (integration): the Phase 4 brief scoped lib/tokens.ts (refreshLongLivedToken).
 * It had not landed when Phase 5 was built, so the token crypto + refresh logic
 * lives HERE (lib/ig-token.ts) and is used by the token-refresh cron and the
 * /admin token-health endpoints. The coordinator should keep this single
 * implementation and have Phase 4's Meta client read the decrypted token via
 * `getDecryptedToken()` below (the signature lib/meta.ts's contract expects).
 *
 * Refresh endpoint (docs re-verified 2026-09-30, plan §1.8):
 *   GET {IG_API_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=…
 * Meta only accepts the refresh when the token is ≥ 24h old; refreshed tokens
 * live ~60 days (expires_in seconds in the response).
 *
 * Tokens are stored AES-256-GCM encrypted in admin_settings/token
 * { enc, iv, expires_at, updated_at }. Plaintext is never logged or persisted.
 */
import crypto from "node:crypto";
import { getEnv } from "./env";
import { getAdminSettings, updateAdminSettings } from "./firebase-admin";
import { log } from "./log";

const REFRESH_DUE_DAYS = 7; // refresh when expires_at - now < 7 days
const MIN_TOKEN_AGE_HOURS = 24; // Meta rejects refreshes of newer tokens

function encKey(): Buffer {
  const hex = getEnv().IG_TOKEN_ENC_KEY;
  if (!hex) throw new Error("IG_TOKEN_ENC_KEY is not set");
  const buf = Buffer.from(hex.trim(), "hex");
  if (buf.length !== 32) throw new Error("IG_TOKEN_ENC_KEY must be a 32-byte hex string");
  return buf;
}

/** AES-256-GCM encrypt. Returns base64 { enc (ciphertext+tag), iv }. */
export function encryptToken(plaintext: string): { enc: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const enc = Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64");
  return { enc, iv: iv.toString("base64") };
}

/** AES-256-GCM decrypt. Throws on tampered input / wrong key. */
export function decryptToken(enc: string, iv: string): string {
  const raw = Buffer.from(enc, "base64");
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Decrypt + return the stored long-lived IG token, or null if absent. */
export async function getDecryptedToken(): Promise<string | null> {
  const { token } = await getAdminSettings();
  if (!token) return null;
  return decryptToken(token.enc, token.iv);
}

export interface RefreshResult {
  token: string;
  expires_at: string; // ISO
}

/**
 * Refresh the stored long-lived token via Meta's refresh_access_token endpoint.
 * Throws when no token is stored, the token is < 24h old (Meta rejects those),
 * or Meta returns an error. Does NOT persist — call storeToken() after.
 */
export async function refreshLongLivedToken(): Promise<RefreshResult> {
  const { token: stored } = await getAdminSettings();
  if (!stored) throw new Error("No IG token stored — cannot refresh");
  const ageMs = Date.now() - new Date(stored.updated_at).getTime();
  if (ageMs < MIN_TOKEN_AGE_HOURS * 3600 * 1000) {
    throw new Error(
      `Token is < ${MIN_TOKEN_AGE_HOURS}h old — Meta rejects refreshes of new tokens`,
    );
  }
  const current = decryptToken(stored.enc, stored.iv);
  const base = getEnv().IG_API_BASE.replace(/\/$/, "");
  const url =
    `${base}/refresh_access_token` +
    `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Meta refresh_access_token failed (${res.status}): ${raw.slice(0, 200)}`);
  }
  let body: { access_token?: string; expires_in?: number };
  try {
    body = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error(`Meta refresh_access_token returned non-JSON: ${raw.slice(0, 120)}`);
  }
  if (!body.access_token) {
    throw new Error(`Meta refresh_access_token missing access_token: ${raw.slice(0, 200)}`);
  }
  const expiresInSec = body.expires_in ?? 60 * 24 * 3600; // ~60 days default
  const expires_at = new Date(Date.now() + expiresInSec * 1000).toISOString();
  return { token: body.access_token, expires_at };
}

/** Encrypt + persist a fresh token; resets token_health to "ok". */
export async function storeToken(token: string, expires_at: string): Promise<void> {
  const { enc, iv } = encryptToken(token);
  await updateAdminSettings({
    token: { enc, iv, expires_at, updated_at: new Date().toISOString() },
    token_health: "ok",
  });
  log.info("ig-token: stored token", { expires_at });
}

/** True when the stored token should be refreshed now (expires within 7 days). */
export function isRefreshDue(expires_at: string | null): boolean {
  if (!expires_at) return true; // unknown expiry → try (will no-op if nothing stored)
  return new Date(expires_at).getTime() - Date.now() < REFRESH_DUE_DAYS * 24 * 3600 * 1000;
}

/** Days until expiry, or null when unknown. */
export function daysUntilExpiry(expires_at: string | null): number | null {
  if (!expires_at) return null;
  return (new Date(expires_at).getTime() - Date.now()) / (24 * 3600 * 1000);
}

/** Mark token health degraded (used when refresh fails). */
export async function markTokenDegraded(reason: string): Promise<void> {
  await updateAdminSettings({ token_health: "degraded" });
  log.warn("ig-token: health marked degraded", { reason: reason.slice(0, 160) });
}
