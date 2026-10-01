/**
 * Admin authorization for /api/admin/* — pure and unit-testable.
 *
 * Grant rule (docs re-verified 2026-09-30, firebase.google.com/docs/auth/admin/custom-claims):
 *   1. Verify the Firebase ID token from `Authorization: Bearer <token>`.
 *   2. Grant if the decoded token carries custom claim `admin === true`.
 *   3. Else grant if the token's email is in the ADMIN_EMAILS allowlist
 *      (bootstrap path for the very first admin, before claims are set).
 *   4. Otherwise 403.
 * 401 = missing/invalid token. 403 = valid token, not an admin.
 * Which path granted is logged (audit trail for the bootstrap window).
 */
import { adminEmailSet } from "./env";
import { log } from "./log";

export interface VerifiedAdminToken {
  uid: string;
  email?: string | null;
  /** Custom claims arrive as top-level props on the decoded token. */
  admin?: unknown;
  [key: string]: unknown;
}

export interface AdminPrincipal {
  uid: string;
  email: string | null;
  via: "claim" | "allowlist";
}

export type AuthorizeResult =
  | { ok: true; principal: AdminPrincipal }
  | { ok: false; status: 401 | 403; error: string };

export async function authorizeAdmin(
  authHeader: string | null | undefined,
  verifyIdToken: (token: string) => Promise<VerifiedAdminToken>,
): Promise<AuthorizeResult> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization Bearer token" };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, status: 401, error: "Missing Authorization Bearer token" };
  }
  let decoded: VerifiedAdminToken;
  try {
    decoded = await verifyIdToken(token);
  } catch {
    log.warn("admin-auth: verifyIdToken failed");
    return { ok: false, status: 401, error: "Invalid or expired ID token" };
  }
  if (decoded.admin === true) {
    log.info("admin-auth: granted via custom claim", { uid: decoded.uid });
    return {
      ok: true,
      principal: { uid: decoded.uid, email: decoded.email ?? null, via: "claim" },
    };
  }
  const email = (decoded.email ?? "").trim().toLowerCase();
  if (email && adminEmailSet().has(email)) {
    log.info("admin-auth: granted via ADMIN_EMAILS allowlist (bootstrap)", { uid: decoded.uid });
    return { ok: true, principal: { uid: decoded.uid, email, via: "allowlist" } };
  }
  log.warn("admin-auth: denied (not admin)", { uid: decoded.uid });
  return { ok: false, status: 403, error: "Access denied: not an admin" };
}
