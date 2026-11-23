/**
 * Vercel Cron: IG long-lived token refresh — GET /api/cron/token-refresh
 * Schedule (vercel.json): `0 3 * * *` UTC = 08:00 PKT daily.
 *
 * Flow: require `Authorization: Bearer <CRON_SECRET>` (Vercel sends it
 * automatically when CRON_SECRET is set). If the stored token expires within
 * 7 days → refreshLongLivedToken() → storeToken(). On failure → notifyAdmin
 * immediately + token_health = "degraded" (surfaces in /admin).
 *
 * GET only. Best-effort/delivery — idempotent (refresh is a no-op unless due).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getAdminSettings } from "@/lib/firebase-admin";
import { log } from "@/lib/log";
import { notifyAdmin } from "@/lib/telegram";
import {
  daysUntilExpiry,
  isRefreshDue,
  markTokenDegraded,
  refreshLongLivedToken,
  storeToken,
} from "@/lib/ig-token";

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { token } = await getAdminSettings();
    if (!token) {
      log.warn("cron/token-refresh: no token stored — nothing to refresh");
      return NextResponse.json({ ok: true, action: "none", reason: "no token stored" });
    }
    const daysLeft = daysUntilExpiry(token.expires_at);
    if (!isRefreshDue(token.expires_at)) {
      return NextResponse.json({
        ok: true,
        action: "none",
        reason: "not due",
        days_left: daysLeft,
      });
    }
    const { token: fresh, expires_at } = await refreshLongLivedToken();
    await storeToken(fresh, expires_at);
    log.info("cron/token-refresh: token refreshed", { expires_at });
    return NextResponse.json({
      ok: true,
      action: "refreshed",
      expires_at,
      days_left: daysUntilExpiry(expires_at),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markTokenDegraded(msg).catch(() => undefined);
    await notifyAdmin(`⚠️ IG token refresh FAILED (cron): ${msg.slice(0, 200)}`);
    log.error("cron/token-refresh: failed", { err: msg.slice(0, 200) });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
