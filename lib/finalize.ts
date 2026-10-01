/**
 * Finalize-photos worker core — Phase 2.
 *
 * Runs PHOTO_DEBOUNCE_SECONDS after the last photo: downloads all photo bytes,
 * makes ONE Gemini vision call (extraction + moderation), applies Phase 3's
 * moderation pipeline, and branches:
 *   FAIL   → listing REJECTED + polite rejection DM
 *   REVIEW → listing NEEDS_REVIEW + Telegram admin alert (+ holding DM)
 *   PASS   → missing fields → NEEDS_INFO + one consolidated question
 *          → complete      → CONFIRM + preview + consent quick replies
 *
 * Fail closed: ANY error (Gemini, download, schema) → NEEDS_REVIEW + alert,
 * never auto-pass. Pure apart from injected deps — unit-testable with fakes;
 * the route wires real implementations. applyModeration is imported from
 * @/lib/moderation (Phase 3) and vitest.mock'ed in tests.
 */
import type { ConversationDoc, FinalizePhotosPayload, ListingDoc, ModerationResult } from "./types";
import { applyModeration } from "./moderation";
import { dhash } from "./images";
import {
  moveToConfirm,
  nextQuestion,
  readyForConfirm,
  sendSafe,
  setConversationState,
  type Deps,
} from "./conversation";
import { politeReject, reviewHoldReply } from "./prompts";
import { log } from "./log";

export interface FinalizeDeps extends Deps {
  downloadBytes: (storagePath: string) => Promise<Buffer>;
}

const PROCESSABLE = new Set(["DRAFT", "NEEDS_INFO"]);

async function markNeedsReview(
  deps: FinalizeDeps,
  listing: ListingDoc,
  convo: ConversationDoc,
  note: string,
): Promise<void> {
  listing.status = "NEEDS_REVIEW";
  await deps.db.saveListing(listing.id, { ...listing });
  await deps.db.appendListingEvent(listing.id, { type: "needs_review", note: note.slice(0, 300) });
  setConversationState(convo, "IDLE");
  convo.active_listing_id = null;
  await deps.db.saveConversation(convo.igsid, { ...convo });
  await deps.notifyAdmin(`🔍 Review needed — listing ${listing.id} (seller ${listing.seller_igsid}): ${note.slice(0, 200)}`, {
    listingId: listing.id,
    igsid: listing.seller_igsid,
  });
  await sendSafe(deps, convo, { text: reviewHoldReply(convo.lang) });
}

export async function handleFinalizePhotos(
  payload: FinalizePhotosPayload,
  deps: FinalizeDeps,
): Promise<{ ok: true; skipped?: string }> {
  const listing = await deps.db.getListing(payload.listing_id);
  if (!listing) {
    log.warn("finalize.listing_missing", { listing_id: payload.listing_id });
    return { ok: true, skipped: "listing_missing" };
  }
  // Debounce guard: a newer photo re-armed the timer — this run is stale.
  if (listing.last_photo_at !== payload.photo_at) {
    log.info("finalize.skipped_rearmed", { listing_id: listing.id });
    return { ok: true, skipped: "rearmed" };
  }
  if (!PROCESSABLE.has(listing.status)) {
    log.info("finalize.skipped_status", { listing_id: listing.id, status: listing.status });
    return { ok: true, skipped: "status" };
  }

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
      } catch (err) {
        log.warn("finalize.dhash_failed", { listing_id: listing.id, index: i });
      }
    }
    await deps.db.saveListing(listing.id, { photos: listing.photos });

    // 2. ONE Gemini vision call: extraction + moderation.
    const vision = await deps.gemini.extractListing(buffers, listing.chat_text ?? "", convo.lang);
    listing.extracted = vision.extracted;
    listing.missing = vision.missing;
    await deps.db.saveListing(listing.id, { ...listing });
    await deps.db.appendListingEvent(listing.id, {
      type: "finalized",
      photo_count: buffers.length,
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
    await deps.db.saveListing(listing.id, { ...listing });

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
      await deps.db.saveListing(listing.id, { ...listing });
      await deps.db.appendListingEvent(listing.id, { type: "rejected", reasons: mod.reasons });
      setConversationState(convo, "IDLE");
      convo.active_listing_id = null;
      await deps.db.saveConversation(convo.igsid, { ...convo });
      const reason = mod.reasons[0] ?? "policy";
      await sendSafe(deps, convo, { text: politeReject(reason, convo.lang) });
      return { ok: true };
    }

    if (mod.verdict === "REVIEW") {
      await markNeedsReview(deps, listing, convo, `moderation REVIEW: ${mod.reasons.join("; ") || "no reason"}`);
      return { ok: true };
    }

    // PASS — check completeness.
    const check = readyForConfirm(listing);
    if (!check.ok) {
      listing.status = "NEEDS_INFO";
      listing.missing = check.missing;
      await deps.db.saveListing(listing.id, { ...listing });
      setConversationState(convo, "NEEDS_INFO");
      await deps.db.saveConversation(convo.igsid, { ...convo });
      const q = nextQuestion(check.missing, convo.lang, listing.photos.length);
      await sendSafe(deps, convo, q.quickReplies ? { text: q.question, quickReplies: q.quickReplies } : { text: q.question });
      return { ok: true };
    }

    await moveToConfirm(deps, convo, listing);
    return { ok: true };
  } catch (err) {
    // Fail closed: never auto-pass on error.
    const msg = err instanceof Error ? err.message : String(err);
    log.error("finalize.failed_closed", { listing_id: listing.id, error: msg.slice(0, 300) });
    await markNeedsReview(deps, listing, convo, `finalize error (fail closed): ${msg}`);
    return { ok: true };
  }
}
