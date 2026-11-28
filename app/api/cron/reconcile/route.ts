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
import { enqueueWorker } from "@/lib/qstash";
import {
  reconcileDecision,
  strandedDecision,
  STUCK_AFTER_MS,
  STRANDED_AFTER_MS,
  type ReconcileDecision,
  type StrandedDecision,
} from "@/lib/reconcile";
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

  // --- Stranded-listing sweep (2026-11-28) ---------------------------------
  // Listings the seller flow left in CONFIRM / NEEDS_INFO / DRAFT never
  // reach /admin (the queue lists review/publish statuses only). After an
  // hour of seller silence, hand them to the admin: CONFIRM → SUBMITTED,
  // NEEDS_INFO/DRAFT with photos → finalize re-run (it routes SUBMITTED
  // or NEEDS_REVIEW from everything received).
  const strandedBefore = new Date(now.getTime() - STRANDED_AFTER_MS).toISOString();
  const sweptSubmitted: string[] = [];
  const sweptFinalize: string[] = [];
  for (const status of ["CONFIRM", "NEEDS_INFO", "DRAFT"] as const) {
    const sSnap = await adminDb()
      .collection("listings")
      .where("status", "==", status)
      .where("created_at", "<", strandedBefore)
      .get();
    for (const doc of sSnap.docs) {
      const outcome = await adminDb().runTransaction<{
        decision: StrandedDecision;
        activityAt: string;
        photoAt: string;
      }>(async (tx) => {
        const freshSnap = await tx.get(doc.ref);
        if (!freshSnap.exists) return { decision: "skip", activityAt: "", photoAt: "" };
        const fresh = freshSnap.data() as ListingDoc;
        const decision = strandedDecision(
          {
            status: fresh.status,
            photoCount: fresh.photos?.length ?? 0,
            lastActivity: fresh.last_activity_at,
            created_at: fresh.created_at,
          },
          now.getTime(),
        );
        if (decision === "submit-confirm") {
          tx.update(doc.ref, { status: "SUBMITTED" });
          const convoRef = adminDb().collection("conversations").doc(fresh.seller_igsid);
          const convoSnap = await tx.get(convoRef);
          if (convoSnap.exists && convoSnap.data()?.active_listing_id === doc.id) {
            tx.update(convoRef, { state: "IDLE", active_listing_id: null });
          }
        }
        const activityAt = fresh.last_activity_at ?? fresh.created_at;
        return { decision, activityAt, photoAt: fresh.last_photo_at ?? activityAt };
      });
      if (outcome.decision === "submit-confirm") {
        await appendListingEvent(doc.id, "submitted", {
          detail: "Reconcile sweep: stranded CONFIRM → SUBMITTED for admin review",
        });
        sweptSubmitted.push(doc.id);
        log.info("cron/reconcile: stranded CONFIRM submitted", { listing: doc.id });
      } else if (outcome.decision === "enqueue-finalize") {
        try {
          await enqueueWorker(
            "finalize-photos",
            {
              kind: "finalize-photos",
              listing_id: doc.id,
              photo_at: outcome.photoAt,
              activity_at: outcome.activityAt,
            },
            { deduplicationId: `finalize-sweep-${doc.id}-${outcome.activityAt}` },
          );
          sweptFinalize.push(doc.id);
          log.info("cron/reconcile: stranded listing finalize re-armed", { listing: doc.id });
        } catch (err) {
          log.warn("cron/reconcile: stranded finalize enqueue failed", {
            listing: doc.id,
            error: err instanceof Error ? err.message.slice(0, 160) : String(err),
          });
        }
      }
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
    swept_submitted: sweptSubmitted,
    swept_finalize: sweptFinalize,
    note: "DM-vs-webhook diff skipped: Conversations API read needs extra scopes (documented limitation).",
  });
}
