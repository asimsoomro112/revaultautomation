/**
 * Instagram token helpers — PHASE 4 contract surface.
 *
 * The AES-256-GCM crypto + refresh/store primitives live in lib/ig-token.ts
 * (Phase 5's single implementation — identical wire format: base64(ct+tag),
 * base64 iv; tokens stored at admin_settings/global.token). This module is the
 * Phase 4 contract adapter:
 *   - re-exports encryptToken / decryptToken unchanged,
 *   - storeToken(plain, expiresAt: Date),
 *   - refreshLongLivedToken(): Promise<{ ok, expires_at? }> (Meta only allows
 *     refresh when the token is ≥ 24h old — returns { ok: false } otherwise),
 *   - exchangeShortLivedToken(shortLived) for setup/manual use.
 */
import { getEnv, requireMetaEnv } from "./env";
import { log } from "./log";
import {
  decryptToken as igDecryptToken,
  encryptToken as igEncryptToken,
  refreshLongLivedToken as igRefresh,
  storeToken as igStoreToken,
} from "./ig-token";

export const encryptToken = igEncryptToken;
export const decryptToken = igDecryptToken;

const TOKEN_TIMEOUT_MS = 20_000;

/** Encrypt + persist the long-lived token (expiresAt as a Date). */
export async function storeToken(plain: string, expiresAt: Date): Promise<void> {
  await igStoreToken(plain, expiresAt.toISOString());
}

/**
 * Refresh the stored long-lived token.
 * Returns { ok: false } (no Meta call) when no token is stored or it is
 * younger than 24h; { ok: true, expires_at } after a successful refresh+store.
 * Other failures (Meta errors, decrypt failures) throw so callers alert.
 */
export async function refreshLongLivedToken(): Promise<{ ok: boolean; expires_at?: string }> {
  try {
    const r = await igRefresh();
    await igStoreToken(r.token, r.expires_at);
    log.info("tokens: long-lived token refreshed + stored", { expires_at: r.expires_at });
    return { ok: true, expires_at: r.expires_at };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected no-op conditions (docs: Meta rejects refresh of <24h tokens).
    if (/no IG token stored/i.test(msg) || /< 24h old/i.test(msg)) {
      log.info("tokens: refresh skipped", { reason: msg.slice(0, 120) });
      return { ok: false };
    }
    throw err;
  }
}

/**
 * Exchange a short-lived (~1h) dashboard token for a 60-day long-lived one.
 * Manual / setup use only (Phase 5 admin "refresh now", SETUP.md flow).
 * Endpoint is UNVERSIONED on graph.instagram.com (docs re-verified 2026-09-30).
 * Does NOT store — call storeToken() with the result.
 */
export async function exchangeShortLivedToken(
  shortLived: string,
): Promise<{ token: string; expires_in: number }> {
  const env = requireMetaEnv();
  const appSecret = env.IG_APP_SECRET;
  if (!appSecret) throw new Error("IG_APP_SECRET is required for the token exchange");
  const url =
    `${env.IG_API_BASE.replace(/\/$/, "")}/access_token` +
    `?grant_type=ig_exchange_token` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&access_token=${encodeURIComponent(shortLived)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Meta access_token exchange failed (${res.status}): ${raw.slice(0, 200)}`);
  }
  let body: { access_token?: string; expires_in?: number };
  try {
    body = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error(`Meta access_token exchange returned non-JSON: ${raw.slice(0, 120)}`);
  }
  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new Error(`Meta access_token exchange missing fields: ${raw.slice(0, 200)}`);
  }
  return { token: body.access_token, expires_in: body.expires_in };
}

/** Where the refresh/exchange endpoints live (unversioned host). */
export function tokenEndpointBase(): string {
  return getEnv().IG_API_BASE.replace(/\/$/, "");
}
