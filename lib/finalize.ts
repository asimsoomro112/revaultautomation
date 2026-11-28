/**
 * Finalize-photos worker core — Phase 2.
 *
 * Runs PHOTO_DEBOUNCE_SECONDS after the last photo: downloads all photo bytes,
 * makes ONE Gemini vision call (extraction + moderation), applies Phase 3's
 * moderation pipeline, and branches:
 *   FAIL   → listing REJECTED + polite rejection DM
 *   REVIEW → listing NEEDS_REVIEW + Telegram admin alert (+ holding DM)
 *   PASS   → complete      → SUBMITTED (admin queue) + submitted DM
 *          → missing fields → NEEDS_REVIEW (admin decides) + holding DM
 *
 * The customer is never interrogated for missing fields (Asim, 2026-11-28):
 * pictures + details in, admin approves or rejects from /admin.
 *
 * Fail closed: ANY error (Gemini, download, schema) → NEEDS_REVIEW + alert,
 * never auto-pass. Pure apart from injected deps — unit-testable with fakes;
 * the route wires real implementations. applyModeration is imported from
 * @/lib/moderation (Phase 3) and vitest.mock'ed in tests.
 */
import type { ConversationDoc, FinalizePhotosPayload, ListingDoc, ModerationResult } from "./types";
import { GeminiError } from "./gemini";
import { applyModeration } from "./moderation";
import { dhash } from "./dhash";
import {
  readyForConfirm,
  sendSafe,
  setConversationState,
  submitToAdminReview,
  type Deps,
} from "./conversation";
import { politeReject, reviewHoldReply } from "./prompts";
import { log } from "./log";

export interface FinalizeDeps extends Deps {
  downloadBytes: (storagePath: string) => Promise<Buffer>;
}

/** Delayed retries of a failed finalize before failing closed (see catch). */
const FINALIZE_MAX_RETRIES = 2;
const FINALIZE_RETRY_DELAY_SEC = 60;

/**
 * Re-arms of one finalize by activity arriving during extraction (see the
 * post-extraction re-check). After this many, the run proceeds with the data
 * it extracted rather than looping — a burst is finite, so this is a safety
 * cap, not a path a human seller can hit.
 */
const FINALIZE_MAX_REARMS = 4;

/**
 * Waits for in-flight photo downloads before extracting (see the inflight
 * guard in handleFinalizePhotos). 8 waits x 15s = 2 minutes max — a burst
 * download slower than that proceeds anyway and the 4b check routes to
 * REVIEW rather than auto-passing a partial set.
 */
const FINALIZE_MAX_INFLIGHT_WAITS = 8;
const FINALIZE_INFLIGHT_WAIT_SEC = 15;

const PROCESSABLE = new Set(["DRAFT", "NEEDS_INFO"]);

async function markNeedsReview(
  deps: FinalizeDeps,
  listing: ListingDoc,
  convo: ConversationDoc,
  note: string,
): Promise<void> {
  // Narrow patch, not a full-doc save: a concurrent photo/chat append must
  // never be clobbered by this status transition.
  await deps.db.saveListing(listing.id, { status: "NEEDS_REVIEW" });
  listing.status = "NEEDS_REVIEW";
  await deps.db.appendListingEvent(listing.id, { type: "needs_review", note: note.slice(0, 300) });
  setConversationState(convo, "IDLE");
  convo.active_listing_id = null;
  // Narrow patch of only the fields finalize owns: the convo was read
  // before the vision call, so a full-doc save would clobber a seller
  // message that arrived during extraction (last_user_msg_at, state,
  // window_open). saveConversation is merge-based, so a partial patch
  // only touches these two fields.
  await deps.db.saveConversation(convo.igsid, {
    state: convo.state,
    active_listing_id: null,
  });
  await deps.notifyAdmin(`🔍 Review needed — listing ${listing.id} (seller ${listing.seller_igsid}): ${note.slice(0, 200)}`, {
    listingId: listing.id,
    igsid: listing.seller_igsid,
  });
  await sendSafe(deps, convo, { text: reviewHoldReply(convo.lang) });
}

/**
 * Best-effort caption draft for listings routed to NEEDS_REVIEW after
 * extraction, so an admin approve can publish without first saving a
 * caption by hand (the publish worker refuses a caption-less listing).
 * A caption failure never blocks the review routing itself.
 */
async function ensureCaptionDraft(deps: FinalizeDeps, listing: ListingDoc, convo: ConversationDoc): Promise<void> {
  if (listing.caption || !listing.extracted) return;
  try {
    const caption = await deps.buildCaption(listing.extracted, convo.lang);
    await deps.db.saveListing(listing.id, { caption });
    listing.caption = caption;
  } catch (err) {
    log.warn("finalize.caption_draft_failed", {
      listing_id: listing.id,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
  }
}

export async function handleFinalizePhotos(
  payload: FinalizePhotosPayload,
  deps: FinalizeDeps,
): Promise<{ ok: true; skipped?: string }> {
  let listing = await deps.db.getListing(payload.listing_id);
  if (!listing) {
    log.warn("finalize.listing_missing", { listing_id: payload.listing_id });
    return { ok: true, skipped: "listing_missing" };
  }
  // Debounce guard: a newer photo re-armed the timer — this run is stale.
  if (listing.last_photo_at !== payload.photo_at) {
    log.info("finalize.skipped_rearmed", { listing_id: listing.id });
    return { ok: true, skipped: "rearmed" };
  }
  // Burst-combine guard: a details text (or another photo) arrived after
  // this run was armed — the newer finalize owns the burst, this one is stale.
  if (payload.activity_at !== undefined && listing.last_activity_at !== payload.activity_at) {
    log.info("finalize.skipped_rearmed_activity", { listing_id: listing.id });
    return { ok: true, skipped: "rearmed" };
  }
  // A finalize with no photos to look at cannot extract anything — the old
  // code let it reach extractListing, whose "no image buffers" error is
  // non-retryable and failed the listing closed to review with nothing
  // extracted (2026-11-23: lst_84dd9f3355b3). Skip instead: the photo's own
  // finalize (or a later one) owns the burst.
  if (listing.photos.length === 0) {
    log.info("finalize.skipped_no_photos", { listing_id: listing.id });
    return { ok: true, skipped: "no_photos" };
  }
  if (!PROCESSABLE.has(listing.status)) {
    log.info("finalize.skipped_status", { listing_id: listing.id, status: listing.status });
    return { ok: true, skipped: "status" };
  }
  // Burst fix (2026-11-24): a photo download still in flight is invisible
  // to the timestamp guards above — ingest bumps last_photo_at BEFORE the
  // slow download, so a finalize fired 25s after an ingest start could
  // read 1 photo with "fresh" timestamps and close the burst on a partial
  // set (2026-11-24: 3 photos sent, 1 extracted). Wait for the downloads
  // to land instead: re-enqueue with a fresh dedup id (the plain
  // finalize-{id}-{activity_at} id would be suppressed inside QStash's
  // 10-minute dedup window) and a wait count. After the cap, proceed
  // anyway — the 4b check below routes to REVIEW if photos arrived during
  // extraction, so a stuck download can never auto-pass a partial set.
  const inflight = listing.inflight_photos ?? 0;
  if (inflight > 0) {
    const waits = payload.inflight_waits ?? 0;
    if (waits < FINALIZE_MAX_INFLIGHT_WAITS) {
      log.info("finalize.waiting_inflight", { listing_id: listing.id, inflight, waits: waits + 1 });
      await deps.enqueueWorker(
        "finalize-photos",
        {
          kind: "finalize-photos",
          listing_id: listing.id,
          photo_at: payload.photo_at,
          activity_at: payload.activity_at,
          attempt: payload.attempt,
          rearm: payload.rearm,
          inflight_waits: waits + 1,
        },
        {
          delaySec: FINALIZE_INFLIGHT_WAIT_SEC,
          deduplicationId: `finalize-wait-${listing.id}-${payload.activity_at ?? payload.photo_at}-${waits + 1}`,
        },
      );
      return { ok: true, skipped: "inflight" };
    }
    log.warn("finalize.inflight_wait_cap", { listing_id: listing.id, inflight });
  }

  // Snapshot the photo count at read time for the post-extraction re-check
  // below: a live object reference (the in-memory fake db returns one;
  // real Firestore returns a snapshot) would otherwise make a photo that
  // arrived during extraction invisible to a length comparison.
  const photoCountAtRead = listing.photos.length;

  const convo = await deps.db.getOrCreateConversation(listing.seller_igsid);

  try {
    // 1. Download every photo's bytes (Meta CDN URLs are never persisted).
    const buffers: Buffer[] = [];
    for (const photo of listing.photos) {
      buffers.push(await deps.downloadBytes(photo.storage_path));
    }

    // 1b. Compute perceptual hashes (ingest leaves phash:"" placeholders).
    // Per-photo failure must not block the listing: vision + moderation are
    // the real safeguards; a missing hash only weakens duplicate detection.
    for (const [i, photo] of listing.photos.entries()) {
      const buf = buffers[i];
      if (!buf) continue;
      try {
        photo.phash = await dhash(buf);
      } catch {
        log.warn("finalize.dhash_failed", { listing_id: listing.id, index: i });
      }
    }
    // Persist hashes transactionally, matched by storage_path against the
    // FRESH photos array: a photo appended after this run's read must survive.
    const phashByPath = new Map(listing.photos.filter((p) => p.phash).map((p) => [p.storage_path, p.phash]));
    if (phashByPath.size > 0) {
      await deps.db.mutateListing(listing.id, (doc) => ({
        patch: {
          photos: doc.photos.map((p) => {
            const ph = phashByPath.get(p.storage_path);
            return ph ? { ...p, phash: ph } : p;
          }),
        },
        result: undefined,
      }));
    }

    // 2. ONE Gemini vision call: extraction + moderation.
    const vision = await deps.gemini.extractListing(buffers, listing.chat_text ?? "", convo.lang);
    // Burst-combine re-check: a photo or details text may have arrived
    // DURING the vision call. Saving this extraction would drop it — the
    // listing would show the old photos/text only (2026-11-23: the text
    // landed mid-extraction and never made it into `extracted`). Discard
    // and re-arm instead; the fresh run extracts the complete burst.
    const expectedActivity = payload.activity_at ?? payload.photo_at;
    const fresh = await deps.db.getListing(payload.listing_id);
    // Burst fix (2026-11-24): activity_at alone cannot see a photo that
    // appended during extraction — the append carries the same activity_at
    // the first mutate already set before the download. A changed photo
    // count, or a download still in flight, means the burst has not
    // settled either, so discard and re-arm on those too.
    const freshInflight = fresh !== null ? (fresh.inflight_photos ?? 0) : 0;
    const photoCountMoved = fresh !== null && fresh.photos.length !== photoCountAtRead;
    const moved =
      (fresh !== null && fresh.last_activity_at !== null && fresh.last_activity_at !== expectedActivity) ||
      photoCountMoved ||
      freshInflight > 0;
    if (fresh !== null && moved && (payload.rearm ?? 0) < FINALIZE_MAX_REARMS) {
      // `moved` is only true when fresh is non-null (every clause needs
      // it); the explicit check narrows the type for the block below.
      const rearm = (payload.rearm ?? 0) + 1;
      log.info("finalize.rearmed_by_activity", { listing_id: listing.id, rearm });
      await deps.db.appendListingEvent(listing.id, {
        type: "finalize_rearmed",
        rearm,
        activity_at: fresh.last_activity_at,
      });
      await deps.enqueueWorker(
        "finalize-photos",
        {
          kind: "finalize-photos",
          listing_id: listing.id,
          photo_at: fresh.last_photo_at ?? payload.photo_at,
          activity_at: fresh.last_activity_at ?? expectedActivity,
          attempt: payload.attempt,
          rearm,
        },
        {
          delaySec: deps.photoDebounceSeconds,
          deduplicationId: `finalize-${listing.id}-${fresh.last_activity_at ?? expectedActivity}`,
        },
      );
      return { ok: true, skipped: "rearmed" };
    }
    // Quiet (or re-arm cap hit): this extraction covers the whole burst.
    // Branch on the fresh read so the photos/chat_text moderation sees are
    // the current ones, not the snapshot from before the vision call.
    if (!fresh) {
      // Listing deleted mid-run — a merge-save here would resurrect it.
      log.warn("finalize.listing_gone", { listing_id: payload.listing_id });
      return { ok: true, skipped: "listing_missing" };
    }
    listing = fresh;
    // An admin decision (or the message worker) may have changed the listing
    // while the seconds-long vision call was in flight. A stale run must not
    // overwrite a REJECT/REVIEW decision, or move the listing to CONFIRM
    // and DM consent buttons, after the fact.
    if (!PROCESSABLE.has(fresh.status)) {
      log.info("finalize.skipped_status_after_extraction", {
        listing_id: listing.id,
        status: fresh.status,
      });
      return { ok: true, skipped: "status" };
    }
    listing.extracted = vision.extracted;
    listing.missing = vision.missing;
    // Narrow patch, not a full-doc save (see markNeedsReview).
    await deps.db.saveListing(listing.id, { extracted: vision.extracted, missing: vision.missing });
    await deps.db.appendListingEvent(listing.id, {
      type: "finalized",
      photo_count: listing.photos.length,
      missing: vision.missing,
    });

    // 3. Phase 3 moderation verdict (fail closed inside).
    const mod = await applyModeration(listing, vision);
    const moderation: ModerationResult = {
      verdict: mod.verdict,
      reasons: mod.reasons,
      counterfeit_claim: vision.moderation.counterfeit_claim,
      text_contact_info: vision.moderation.text_contact_info,
      per_image: vision.moderation.per_image,
    };
    listing.moderation = moderation;
    // Narrow patch, not a full-doc save (see markNeedsReview).
    await deps.db.saveListing(listing.id, { moderation });

    // 3b. Record perceptual hashes in the duplicate index. Done for every
    // verdict (after moderation has read the index, so a listing never
    // matches itself) — a resubmitted photo must be flaggable even when
    // this listing was rejected or sent to review.
    for (const photo of listing.photos) {
      if (/^[0-9a-f]{16}$/i.test(photo.phash)) {
        await deps.db.recordPhash(photo.phash, listing.id);
      }
    }

    // 4. Branch on verdict.
    if (mod.verdict === "FAIL") {
      listing.status = "REJECTED";
      // Narrow patch, not a full-doc save (see markNeedsReview).
      await deps.db.saveListing(listing.id, { status: "REJECTED" });
      await deps.db.appendListingEvent(listing.id, { type: "rejected", reasons: mod.reasons });
      setConversationState(convo, "IDLE");
      convo.active_listing_id = null;
      // Narrow patch of only the fields finalize owns (see markNeedsReview).
      await deps.db.saveConversation(convo.igsid, {
        state: convo.state,
        active_listing_id: null,
      });
      const reason = mod.reasons[0] ?? "policy";
      await sendSafe(deps, convo, { text: politeReject(reason, convo.lang) });
      return { ok: true };
    }

    // 4b. A photo arrived during the vision call (re-arm cap hit): it is in
    // fresh.photos but was never in `buffers` — never visioned or moderated.
    // Never auto-confirm a listing with an unexamined photo; route to human
    // review instead. (A FAIL above still wins: the examined photos are
    // already bad, so the listing is rejected outright.)
    if (listing.photos.length > buffers.length) {
      await ensureCaptionDraft(deps, listing, convo);
      await markNeedsReview(
        deps,
        listing,
        convo,
        `photo arrived during extraction (re-arm cap) — ${listing.photos.length - buffers.length} photo(s) not visioned`,
      );
      return { ok: true };
    }

    if (mod.verdict === "REVIEW") {
      await ensureCaptionDraft(deps, listing, convo);
      await markNeedsReview(deps, listing, convo, `moderation REVIEW: ${mod.reasons.join("; ") || "no reason"}`);
      return { ok: true };
    }

    // PASS — hand it to the admin either way. Complete listings land in
    // the queue as SUBMITTED; incomplete ones as NEEDS_REVIEW with the
    // missing fields recorded. No follow-up questions to the customer and
    // no seller confirm tap (Asim, 2026-11-28) — approve/reject is the
    // admin's call, and releasing the conversation lets the customer's
    // next post start a fresh listing.
    const check = readyForConfirm(listing);
    if (!check.ok) {
      await submitToAdminReview(deps, convo, listing, {
        status: "NEEDS_REVIEW",
        missing: check.missing,
        note: `incomplete listing sent to admin review — missing: ${check.missing.join(", ")}`,
      });
      return { ok: true };
    }

    await submitToAdminReview(deps, convo, listing, { status: "SUBMITTED", missing: [] });
    return { ok: true };
  } catch (err) {
    // A transient failure (Gemini 503/429 spike, network blip, storage
    // hiccup) must not strand the listing in review with nothing extracted
    // on the first spike — retry once after a delay, then fail closed.
    // A non-retryable Gemini error (bad schema, no buffers) fails the same
    // way again, so it fails closed at once.
    const msg = err instanceof Error ? err.message : String(err);
    const attempt = payload.attempt ?? 0;
    if (attempt < FINALIZE_MAX_RETRIES && isRetryableFinalizeError(err)) {
      log.warn("finalize.retry_scheduled", {
        listing_id: listing.id,
        attempt: attempt + 1,
        error: msg.slice(0, 200),
      });
      await deps.db.appendListingEvent(listing.id, {
        type: "finalize_retry",
        attempt: attempt + 1,
        error: msg.slice(0, 200),
      });
      // Re-read fresh photo/activity timestamps: activity may have moved
      // during the failed run (e.g. a NEEDS_INFO answer bumps it without
      // re-arming finalize). A retry carrying the stale payload would skip
      // as "rearmed" and strand the listing. The dedup id keeps a duplicate
      // delivery of this retry from running twice (AGENTS.md idempotency)
      // AND carries the fresh activity_at as the failure-cycle
      // discriminator: an attempt number alone is reused across unrelated
      // failure cycles, and QStash would suppress the second cycle's retry
      // inside its dedup window (Lane A NEW-3, 2026-11-24 re-audit).
      const freshRetry = await deps.db.getListing(listing.id);
      const retryActivity = freshRetry?.last_activity_at ?? payload.activity_at ?? payload.photo_at;
      await deps.enqueueWorker(
        "finalize-photos",
        {
          kind: "finalize-photos",
          listing_id: listing.id,
          photo_at: freshRetry?.last_photo_at ?? payload.photo_at,
          activity_at: freshRetry?.last_activity_at ?? payload.activity_at,
          attempt: attempt + 1,
          rearm: payload.rearm,
        },
        {
          delaySec: FINALIZE_RETRY_DELAY_SEC,
          deduplicationId: `finalize-retry-${listing.id}-${attempt + 1}-${retryActivity}`,
        },
      );
      return { ok: true };
    }
    // Fail closed: never auto-pass on error.
    log.error("finalize.failed_closed", { listing_id: listing.id, error: msg.slice(0, 300) });
    await markNeedsReview(deps, listing, convo, `finalize error (fail closed): ${msg}`);
    return { ok: true };
  }
}

/** True when a finalize failure is worth one delayed retry. */
function isRetryableFinalizeError(err: unknown): boolean {
  if (err instanceof GeminiError) return err.retryable;
  return true;
}
