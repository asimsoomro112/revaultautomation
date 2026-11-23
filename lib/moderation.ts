/**
 * Moderation verdict pipeline — FAIL CLOSED.
 *
 * Contract (Phase 2 imports this exactly):
 *   export interface ModerationOutcome { verdict: ModerationVerdict; reasons: string[] }
 *   export async function applyModeration(listing: ListingDoc, vision: VisionResult): Promise<ModerationOutcome>
 *
 * Layering (worst verdict wins — FAIL > REVIEW > PASS):
 *   1. Seller blocklist → FAIL
 *   2. Duplicate photo detection (exact dHash, or Hamming distance ≤ 6 vs
 *      recent index entries) → REVIEW — a *different* listing only; the same
 *      listing re-checking itself is never a duplicate.
 *   3. Gemini vision verdict FAIL → FAIL (reasons merged in)
 *   4. Per-image severe flags (nudity_sexual, minors, offensive_text) → FAIL
 *   5. Suspicion flags (visible_faces, image contact_info, counterfeit_claim,
 *      stock/stolen suspicion, text contact_info, no clothing detected) → REVIEW
 *   6. ANY exception at any step → REVIEW with reason ['moderation_error']
 *      (fail closed — a broken safeguard never auto-passes).
 */
import type { ListingDoc, ModerationVerdict } from "./types";
import type { VisionResult } from "./gemini";
import { hammingDistance } from "./images";
import { findDuplicatePhashEntry, findRecentPhashes, isSellerBlocklisted } from "./db";
import { log } from "./log";

export interface ModerationOutcome {
  verdict: ModerationVerdict;
  reasons: string[];
}

/**
 * dHash Hamming threshold for "same photo, likely reposted".
 * 6/64 bits (~9%) tolerates recompression / light re-editing while staying far
 * from the >10+ distance typical of genuinely different scenes (see tests).
 */
export const DUP_HAMMING_THRESHOLD = 6;

const PHASH_RE = /^[0-9a-f]{16}$/i;

function isValidPhash(phash: string): boolean {
  return PHASH_RE.test(phash);
}

/**
 * Check a listing's photos against the duplicate index.
 * Returns true when any photo looks like a repost from a DIFFERENT listing.
 * Malformed hashes are skipped (warn-logged) — the duplicate check is an
 * advisory REVIEW signal only, never a PASS blocker.
 */
async function hasDuplicate(listing: ListingDoc): Promise<boolean> {
  const phashes = listing.photos.map((p) => p.phash).filter(isValidPhash);
  if (phashes.length === 0) {
    log.warn("moderation: no valid phashes to check", { listing_id: listing.id });
    return false;
  }

  // Exact matches first (single key reads, full entry for the owner check).
  for (const phash of phashes) {
    const hit = await findDuplicatePhashEntry(phash);
    if (hit && hit.listing_id && hit.listing_id !== listing.id) {
      log.info("moderation: exact dhash duplicate", {
        listing_id: listing.id,
        duplicate_of: hit.listing_id,
      });
      return true;
    }
  }

  // Near-duplicates: one bounded read of recent entries, then in-memory Hamming.
  const recent = await findRecentPhashes();
  for (const phash of phashes) {
    for (const entry of recent) {
      if (entry.listing_id === listing.id) continue; // not a repost of itself
      if (!isValidPhash(entry.phash)) continue;
      if (hammingDistance(phash, entry.phash) <= DUP_HAMMING_THRESHOLD) {
        log.info("moderation: near-duplicate dhash", {
          listing_id: listing.id,
          duplicate_of: entry.listing_id,
        });
        return true;
      }
    }
  }
  return false;
}

export async function applyModeration(
  listing: ListingDoc,
  vision: VisionResult,
): Promise<ModerationOutcome> {
  try {
    // 1. Blocklist — checked first, independent of vision quality.
    if (await isSellerBlocklisted(listing.seller_igsid)) {
      return { verdict: "FAIL", reasons: ["seller_blocklisted"] };
    }

    const reasons = new Set<string>();
    let verdict: ModerationVerdict = "PASS";
    const fail = (reason: string): void => {
      verdict = "FAIL";
      reasons.add(reason);
    };
    const review = (reason: string): void => {
      if (verdict === "PASS") verdict = "REVIEW";
      reasons.add(reason);
    };

    // 2. Duplicate detection.
    if (await hasDuplicate(listing)) {
      review("possible_duplicate");
    }

    // 3. Vision model's own verdict (merge its reasons verbatim).
    const vm = vision.moderation;
    if (vm.verdict === "FAIL") {
      for (const r of vm.reasons) fail(r);
      fail("vision_verdict_fail");
    } else if (vm.verdict === "REVIEW") {
      for (const r of vm.reasons) review(r);
    }

    // 4. Per-image severe flags → FAIL.
    for (const img of vm.per_image ?? []) {
      if (img.nudity_sexual) fail("nudity_sexual");
      if (img.minors) fail("minors");
      if (img.offensive_text) fail("offensive_text");
    }

    // 5. Suspicion flags → REVIEW (human eyes in /admin).
    for (const img of vm.per_image ?? []) {
      if (img.visible_faces) review("visible_faces");
      if (img.contact_info) review("contact_info_in_image");
      if (img.stock_or_stolen_suspicion) review("stock_or_stolen_suspicion");
    }
    if (vm.counterfeit_claim) review("counterfeit_claim");
    if (vm.text_contact_info) review("text_contact_info");
    if ((vm.per_image ?? []).length > 0 && (vm.per_image ?? []).every((i) => !i.is_clothing)) {
      review("no_clothing_detected");
    }

    return { verdict, reasons: [...reasons] };
  } catch (err) {
    // Fail closed: any error in the safeguard chain becomes REVIEW, never PASS.
    log.error("moderation pipeline error (fail closed)", {
      listing_id: listing.id,
      err: String(err),
    });
    return { verdict: "REVIEW", reasons: ["moderation_error"] };
  }
}
