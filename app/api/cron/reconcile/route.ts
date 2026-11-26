/**
 * Vercel Cron: publish-pipeline reconciliation — GET /api/cron/reconcile
 * Schedule (vercel.json): daily 04:00 UTC = 09:00 PKT.
 *
 * Cheap insurance: any listing stuck in PUBLISHING with no worker activity for
 * > 2h is marked FAILED (with last_error) and the admin is alerted on
 * Telegram. The admin can retry from /admin — retry reuses the idempotency
 * record, so a stuck worker that later wakes up cannot double-post.
 *
 * Guards (2026-11-24 audit HIGH #3): a listing is only failed when it is
 * still PUBLISHING, has no media_id, and holds no live claim lease — all
 * re-checked inside a Firestore transaction together with the latest
 * audit event, so a worker that wakes up mid-reconcile is never failed
 * underneath itself. A media_id listing (post live on IG) with an expired
 * lease is handed to the publish worker's permalink recovery instead.
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
import { enqueuePublishWorker } from "@/lib/publish-queue";
import { reconcileDecision, STUCK_AFTER_MS, type ReconcileDecision } from "@/lib/reconcile";
import { notifyAdmin } from "@/lib/telegram";
import type { ListingDoc } from "@/lib/types";

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();
  const snap = await adminDb()
    .collection("listings")
    .where("status", "==", "PUBLISHING")
    .where("created_at", "<", stuckBefore)
    .get();

  const recovered: string[] = [];
  const liveMedia: string[] = [];
  const recoveryEnqueued: string[] = [];
  const skippedLease: string[] = [];

  for (const doc of snap.docs) {
    // One transaction per candidate: re-read the listing AND its latest
    // audit event, decide on the fresh state, and only then write. A
    // worker claim (lease/status/media_id change) landing between the
    // query above and this write therefore wins instead of being failed.
    const decision = await adminDb().runTransaction<ReconcileDecision>(async (tx) => {
      const freshSnap = await tx.get(doc.ref);
      if (!freshSnap.exists) return "skip-not-publishing";
      const fresh = freshSnap.data() as ListingDoc;
      let lastActivity: string | null = null;
      try {
        const ev = await tx.get(doc.ref.collection("events").orderBy("at", "desc").limit(1));
        lastActivity = (ev.docs[0]?.data()?.at as string | undefined) ?? null;
      } catch {
        lastActivity = null;
      }
      const d = reconcileDecision(
        {
          status: fresh.status,
          created_at: fresh.created_at,
          publish: fresh.publish,
          lastActivity,
        },
        now.getTime(),
      );
      if (d === "fail") {
        tx.update(doc.ref, {
          status: "FAILED",
          "publish.last_error": "reconcile: stuck in PUBLISHING > 2h with no worker activity",
        });
      }
      return d;
    });

    if (decision === "fail") {
      await appendListingEvent(doc.id, "publish_failed", {
        detail: "Reconcile cron: stuck in PUBLISHING > 2h → FAILED",
      });
      recovered.push(doc.id);
      log.warn("cron/reconcile: stuck listing marked FAILED", { listing: doc.id });
    } else if (decision === "recover-live-media" || decision === "skip-live-media") {
      liveMedia.push(doc.id);
      if (decision === "recover-live-media") {
        // Post is live but the listing never reached PUBLISHED: the
        // publish worker's media_id path recovers the permalink without
        // calling media_publish again.
        const enqueued = await enqueuePublishWorker(doc.id);
        if (enqueued) {
          recoveryEnqueued.push(doc.id);
        } else {
          log.warn("cron/reconcile: live-media recovery enqueue failed", { listing: doc.id });
        }
      }
      log.info("cron/reconcile: live-media listing left for recovery", {
        listing: doc.id,
        decision,
      });
    } else if (decision === "skip-lease") {
      skippedLease.push(doc.id);
    }
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
    live_media: liveMedia,
    recovery_enqueued: recoveryEnqueued,
    skipped_lease: skippedLease,
    note: "DM-vs-webhook diff skipped: Conversations API read needs extra scopes (documented limitation).",
  });
}
