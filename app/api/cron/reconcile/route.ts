/**
 * Vercel Cron: publish-pipeline reconciliation — GET /api/cron/reconcile
 * Schedule (vercel.json): every 6 hours at minute 0 UTC = 05:00 / 11:00 / 17:00 / 23:00 PKT.
 *
 * Cheap insurance: any listing stuck in PUBLISHING with no worker activity for
 * > 2h is marked FAILED (with last_error) and the admin is alerted on
 * Telegram. The admin can retry from /admin — retry reuses the idempotency
 * record, so a stuck worker that later wakes up cannot double-post.
 *
 * LIMITATION (documented, per plan §16): the "proper" reconciliation would
 * list recent Instagram conversations and diff them against processed mids,
 * but the Conversations API read needs extra scopes we don't request, so that
 * half is intentionally skipped. This route covers the stuck-publish case,
 * which is the failure mode that actually needs a human.
 *
 * GET only. Idempotent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { adminDb, appendListingEvent } from "@/lib/firebase-admin";
import { log } from "@/lib/log";
import { notifyAdmin } from "@/lib/telegram";

const STUCK_AFTER_MS = 2 * 3600 * 1000;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const snap = await adminDb()
    .collection("listings")
    .where("status", "==", "PUBLISHING")
    .where("created_at", "<", stuckBefore)
    .get();

  const recovered: string[] = [];
  for (const doc of snap.docs) {
    // Confirm no recent worker activity via the latest audit event.
    let lastActivity: string | null = null;
    try {
      const ev = await doc.ref.collection("events").orderBy("at", "desc").limit(1).get();
      lastActivity = (ev.docs[0]?.data()?.at as string | undefined) ?? null;
    } catch {
      lastActivity = null;
    }
    const anchor = lastActivity ?? (doc.data()?.created_at as string | undefined) ?? "";
    if (anchor >= stuckBefore) continue; // active recently — leave it alone

    await doc.ref.update({
      status: "FAILED",
      "publish.last_error": "reconcile: stuck in PUBLISHING > 2h with no worker activity",
    });
    await appendListingEvent(doc.id, "publish_failed", {
      detail: "Reconcile cron: stuck in PUBLISHING > 2h → FAILED",
    });
    recovered.push(doc.id);
    log.warn("cron/reconcile: stuck listing marked FAILED", { listing: doc.id });
  }

  if (recovered.length > 0) {
    await notifyAdmin(
      `🔧 Reconcile: ${recovered.length} listing(s) stuck in PUBLISHING > 2h were marked FAILED (retry from /admin):\n${recovered.join("\n")}`,
    );
  }

  return NextResponse.json({
    ok: true,
    checked: snap.size,
    recovered,
    note: "DM-vs-webhook diff skipped: Conversations API read needs extra scopes (documented limitation).",
  });
}
