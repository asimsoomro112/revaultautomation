/**
 * Publish worker — Phase 4.
 *
 * Invoked by QStash with { kind: "publish", listing_id }:
 *  1. IDEMPOTENCY FIRST — already PUBLISHED → no-op; media_id set but not
 *     marked → recover via getPermalink (a crash between media_publish and the
 *     Firestore write must never double-post).
 *  2. Atomic claim (SUBMITTED/APPROVED/QUEUED → PUBLISHING + 10-min lease) so
 *     two concurrent deliveries can never publish twice.
 *  3. Kill switch (re-read before EVERY Meta call) → park + Telegram alert.
 *  4. review mode + SUBMITTED (not yet approved) → QUEUED, wait for /admin.
 *  5. auto/dry_run → computeNextSlot (Asia/Karachi); future slot → re-enqueue
 *     with notBefore.
 *  6. Live Meta quota (content_publishing_limit) → exhausted → reschedule to
 *     tomorrow 12:00 PKT.
 *  7. Build slides: raw bytes → processSlide (1080×1350) → private upload →
 *     4h signed URLs (never persisted).
 *  8. Create containers (single photo → image container + caption; else child
 *     containers), enqueue poll-container per child (delaySec 30).
 *
 * dry_run runs every step EXCEPT media_publish (the poll worker logs
 * "would publish" and marks PUBLISHED with permalink=null, last_error='dry_run').
 */
import { computeNextSlot, tomorrowWindowStart, tzDay } from "@/lib/schedule";
import { log } from "@/lib/log";
import {
  failListing,
  liveSettings,
  parkForKillSwitch,
  KillSwitchEngaged,
  type WorkerDeps,
} from "./common";
import type { ListingDoc } from "@/lib/types";

export interface PublishOutcome {
  outcome:
    | "missing"
    | "already-published"
    | "recovered"
    | "recover-failed"
    | "not-claimed"
    | "killed"
    | "queued-review"
    | "scheduled"
    | "quota-exhausted"
    | "containers-created"
    | "failed";
  slot_at?: string;
  container_ids?: string[];
  error?: string;
}

export async function handlePublish(
  listingId: string,
  deps: WorkerDeps,
): Promise<PublishOutcome> {
  // --- 0. Load + idempotency (before any side effect) -------------------------
  const pre = await deps.getListing(listingId);
  if (!pre) {
    log.warn("publish worker: listing not found", { listing_id: listingId });
    return { outcome: "missing" };
  }
  if (pre.status === "PUBLISHED") {
    log.info("publish worker: already PUBLISHED, no-op", { listing_id: listingId });
    return { outcome: "already-published" };
  }
  if (pre.publish.media_id && !pre.publish.permalink) {
    // Crashed between media_publish and the PUBLISHED write — recover without
    // calling media_publish again (double-post guard).
    try {
      const permalink = await deps.getMeta().getPermalink(pre.publish.media_id);
      await deps.saveListing(listingId, {
        status: "PUBLISHED",
        publish: { ...pre.publish, permalink, last_error: null, locked_until: null },
      });
      await deps.appendEvent(listingId, "publish_recovered", { media_id: pre.publish.media_id });
      log.info("publish worker: recovered interrupted publish", { listing_id: listingId });
      return { outcome: "recovered" };
    } catch (err) {
      log.warn("publish worker: recovery failed, will retry", {
        listing_id: listingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: "recover-failed" };
    }
  }

  // --- 1. Atomic claim ---------------------------------------------------------
  const claim = await deps.claimListing(listingId);
  if (!claim) return { outcome: "missing" };
  if (claim.alreadyPublished) return { outcome: "already-published" };
  if (!claim.claimed) {
    log.info("publish worker: listing not claimable (another worker holds it)", {
      listing_id: listingId,
      status: claim.doc.status,
    });
    return { outcome: "not-claimed" };
  }
  const listing: ListingDoc = claim.doc;

  try {
    // --- 2. Kill switch + mode gate -------------------------------------------
    let settings = await liveSettings(deps);
    // NOTE: compare pre-claim status — the claim already flipped it to PUBLISHING.
    if (settings.publish_mode === "review" && claim.preStatus === "SUBMITTED") {
      await deps.saveListing(listingId, {
        status: "QUEUED",
        publish: { ...listing.publish, locked_until: null, last_error: null },
      });
      await deps.appendEvent(listingId, "queued_awaiting_review", {});
      log.info("publish worker: review mode — queued for admin approval", { listing_id: listingId });
      return { outcome: "queued-review" };
    }

    // --- 3. Slot ---------------------------------------------------------------
    const now = deps.now();
    const tz = settings.posting_window.tz;
    const slot = computeNextSlot({
      now,
      postsToday: await deps.getPostsToday(tzDay(now, tz)),
      lastPublishAt: await deps.getLastPublish(),
      maxPostsPerDay: settings.max_posts_per_day,
      minGapMinutes: settings.min_gap_minutes,
      windowStart: settings.posting_window.start,
      windowEnd: settings.posting_window.end,
      tz,
    });
    if (slot.getTime() > now.getTime() + 5_000) {
      await deps.enqueuePublish(listingId, {
        notBefore: slot,
        deduplicationId: `publish:${listingId}:${slot.getTime()}`,
      });
      await deps.saveListing(listingId, {
        status: "QUEUED",
        publish: { ...listing.publish, slot_at: slot.toISOString(), locked_until: null },
      });
      await deps.appendEvent(listingId, "slot_scheduled", { slot_at: slot.toISOString() });
      log.info("publish worker: scheduled for slot", { listing_id: listingId, slot_at: slot.toISOString() });
      return { outcome: "scheduled", slot_at: slot.toISOString() };
    }

    // --- 4. Live Meta quota ----------------------------------------------------
    settings = await liveSettings(deps);
    const meta = deps.getMeta();
    const { quota_usage, quota_total } = await meta.getPublishingLimit();
    log.info("publish worker: quota check", { listing_id: listingId, quota_usage, quota_total });
    if (quota_usage >= quota_total) {
      const tomorrow = tomorrowWindowStart(now, settings.posting_window.start, tz);
      await deps.enqueuePublish(listingId, {
        notBefore: tomorrow,
        deduplicationId: `publish:${listingId}:${tomorrow.getTime()}:quota`,
      });
      await deps.saveListing(listingId, {
        status: "QUEUED",
        publish: {
          ...listing.publish,
          slot_at: tomorrow.toISOString(),
          locked_until: null,
          last_error: "quota_exhausted",
        },
      });
      await deps.appendEvent(listingId, "quota_exhausted", { quota_usage, quota_total });
      await deps.notify(
        `⚠️ IG publish quota exhausted (${quota_usage}/${quota_total}) — listing ${listingId} rescheduled to ${tomorrow.toISOString()}`,
        { listingId },
      );
      return { outcome: "quota-exhausted" };
    }

    // --- 5. Build slides ---------------------------------------------------------
    if (!listing.caption || listing.photos.length === 0) {
      throw new Error("listing has no caption or no photos — cannot publish");
    }
    const urls: string[] = [];
    for (let n = 0; n < listing.photos.length; n++) {
      const photo = listing.photos[n];
      if (!photo) continue;
      const raw = await deps.download(photo.storage_path);
      const processed = await deps.processImage(raw);
      const slidePath = `slides/${listingId}/${n}.jpg`;
      await deps.upload(slidePath, processed, "image/jpeg");
      urls.push(await deps.signedUrl(slidePath, 4)); // 4h TTL per plan §1.4
    }
    if (urls.length === 0) throw new Error("slide build produced no images");

    // --- 6. Create containers ----------------------------------------------------
    settings = await liveSettings(deps);
    const containerIds: string[] = [];
    if (urls.length === 1) {
      const id = await meta.createImageContainer(urls[0] as string, { caption: listing.caption });
      containerIds.push(id);
    } else {
      for (const u of urls) {
        settings = await liveSettings(deps); // re-read before EVERY Meta call
        containerIds.push(await meta.createImageContainer(u, { isCarouselItem: true }));
      }
    }
    const container_status: Record<string, "IN_PROGRESS"> = {};
    for (const id of containerIds) container_status[id] = "IN_PROGRESS";
    await deps.saveListing(listingId, {
      publish: {
        ...listing.publish,
        container_ids: containerIds,
        container_status,
        attempts: listing.publish.attempts,
      },
    });
    for (const id of containerIds) {
      await deps.enqueuePoll(
        { kind: "poll-container", listing_id: listingId, container_id: id, role: "child", attempt: 0 },
        { delaySec: 30, deduplicationId: `poll:${listingId}:${id}:0` },
      );
    }
    await deps.appendEvent(listingId, "containers_created", { container_ids: containerIds });
    log.info("publish worker: containers created, polling enqueued", {
      listing_id: listingId,
      container_ids: containerIds,
    });
    return { outcome: "containers-created", container_ids: containerIds };
  } catch (err) {
    if (err instanceof KillSwitchEngaged) {
      await parkForKillSwitch(deps, listing);
      return { outcome: "killed" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await failListing(deps, listing, msg);
    return { outcome: "failed", error: msg };
  }
}
