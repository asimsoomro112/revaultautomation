/**
 * Shared domain types for the ReVault DM-to-Post bot.
 * DO NOT change these shapes without updating ALL consumers and noting it in
 * your phase walkthrough. These are the integration contracts.
 */

import type { ContainerStatus } from "./meta";

/**
 * Deep-partial patch for Firestore `{ merge: true }` writes (e.g. saveListing):
 * nested objects may be patched field-by-field; arrays are replaced wholesale.
 */
export type DeepPartial<T> = T extends unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// --- Conversation dialogue state (per sender IGSID) ---
export type ConversationState = "IDLE" | "COLLECTING" | "NEEDS_INFO" | "CONFIRM";
export type Lang = "ur" | "roman" | "en";

// --- Listing pipeline status (per listing; listing id = idempotency key) ---
export type ListingStatus =
  | "DRAFT"
  | "NEEDS_INFO"
  | "CONFIRM"
  | "SUBMITTED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "QUEUED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "REJECTED"
  | "FAILED";

export type ModerationVerdict = "PASS" | "REVIEW" | "FAIL";
export type PublishMode = "review" | "auto" | "dry_run";
export type Intent = "SELLER_SUBMIT" | "BUYER_QUESTION" | "OTHER";

export type Condition = "new" | "like_new" | "good" | "fair";
export const CONDITIONS: Condition[] = ["new", "like_new", "good", "fair"];

// --- Structured extraction (Gemini vision → zod). NEVER hallucinate:
// brand/size/price must be null/absent unless visible/stated with confidence. ---
export interface ExtractedItem {
  title: string;
  category: string | null;
  gender: string | null;
  /** Brand ONLY if visible on a tag/logo in the photos, else null. */
  brand: string | null;
  color: string | null;
  size: string | null;
  condition: Condition | null;
  /** Price in PKR, ONLY if stated by the seller or visible; else null. */
  price_pkr: number | null;
  city: string | null;
  defects: string[];
  measurements: string | null;
  /** 0..1 confidence per field; low-confidence fields go to `missing`. */
  confidence: Record<string, number>;
}

export interface PerImageModeration {
  photo_index: number;
  is_clothing: boolean;
  nudity_sexual: boolean;
  visible_faces: boolean;
  minors: boolean;
  offensive_text: boolean;
  contact_info: boolean;
  stock_or_stolen_suspicion: boolean;
}

export interface ModerationResult {
  verdict: ModerationVerdict;
  reasons: string[];
  counterfeit_claim: boolean;
  text_contact_info: boolean;
  per_image: PerImageModeration[];
}

export interface ListingPhoto {
  storage_path: string; // logical photo path, e.g. raw/{listingId}/{photoId}.jpg → Cloudinary public_id revault/listings/...
  w: number;
  h: number;
  phash: string; // 16-hex-char dHash
  received_at: string; // ISO
}

export interface ListingDoc {
  id: string;
  seller_igsid: string;
  created_at: string; // ISO
  status: ListingStatus;
  photos: ListingPhoto[];
  last_photo_at: string | null; // ISO — drives the debounce timer
  /**
   * ISO of the last user activity on this listing (photo OR text).
   * Burst-combine (2026-11-23): a details text arriving after the photos
   * must delay extraction until the burst settles, and an extraction that
   * started before a late photo/text must be discarded, not saved — so
   * finalize keys its staleness checks on this, not just last_photo_at.
   */
  last_activity_at: string | null;
  /**
   * Burst fix (2026-11-24): how many photo downloads are currently in
   * flight for this listing. Ingest bumps this BEFORE the slow Meta CDN
   * fetch + Cloudinary upload and drops it when the photo is appended (or
   * the download fails). Finalize refuses to extract while this is > 0 —
   * the old timestamp-only guards could not see a download in flight, so
   * a finalize fired 25s after a photo's ingest start could read 1 photo
   * with "fresh" timestamps and close the burst on a partial set.
   * Absent (old docs) reads as 0.
   */
  inflight_photos?: number | undefined;
  /**
   * The "video support nahi hota" notice is sent at most once per listing
   * (2026-11-28: Nina's forwarded batches each carried a video alongside
   * 3–6 photos, and the notice repeated after every batch). Absent reads
   * as false.
   */
  video_notice_sent?: boolean | undefined;
  /**
   * ISO of the last seller details dump (a text parsing to ≥2 fields) on
   * this listing. Item boundary (2026-11-28): Nina sent three separate
   * items minutes apart, each photos + its own details dump, and the
   * burst-combine merged them into one "bundle" listing. Once a listing
   * has photos + a details dump, a later photo/dump after a quiet gap
   * starts the NEXT item instead of joining this one.
   */
  details_received_at?: string | null | undefined;
  extracted: ExtractedItem | null;
  missing: string[]; // fields still needed / low confidence
  moderation: ModerationResult | null;
  caption: string | null;
  consent: { at: string; message_id: string } | null;
  /** Phase 2: accumulated seller chat text feeding the vision extraction call. */
  chat_text: string;
  publish: {
    slot_at: string | null; // ISO
    container_ids: string[];
    parent_container_id: string | null;
    /** Latest known status per container id (children + parent). */
    container_status: Record<string, ContainerStatus>;
    /** Claim lease (ISO) — guards against two workers publishing twice. */
    locked_until: string | null;
    media_id: string | null;
    permalink: string | null;
    attempts: number;
    last_error: string | null;
  };
  review: { note: string | null; decided_by: string | null; decided_at: string | null };
}

export interface ConversationDoc {
  igsid: string;
  state: ConversationState;
  lang: Lang;
  active_listing_id: string | null;
  intent: Intent | null;
  listings_today: number;
  listings_day: string; // yyyy-MM-dd in Asia/Karachi
  last_user_msg_at: string | null; // ISO — 24h window anchor
  window_open: boolean;
  human_needed: boolean;
  blocked: boolean;
  msg_count_1h: number;
  msg_window_start: string | null; // ISO
  /** Phase 2: total inbound user messages — language is (re)detected on the first 2. */
  user_msg_total: number;
  /** Phase 2: last inbound mid fully seen by the message worker (idempotency). */
  last_processed_mid: string | null;
}

export interface AdminSettings {
  global_kill_switch: boolean;
  publish_mode: PublishMode;
  max_posts_per_day: number;
  min_gap_minutes: number;
  posting_window: { start: string; end: string; tz: string };
  max_listings_per_seller_per_day: number;
  photo_debounce_seconds: number;
  retention_days: number;
  caption_cta: "dm" | "site";
  cover_slide_enabled: boolean;
  faq_buyer: string;
  ig_user_id: string;
  token: { enc: string; iv: string; expires_at: string; updated_at: string } | null;
  token_health: "ok" | "degraded" | "missing";
}

// --- Normalized inbound webhook message (produced by lib/webhook.ts) ---
export type InboundKind = "text" | "image" | "quick_reply" | "unsupported" | "echo" | "unknown";

export interface NormalizedInbound {
  kind: InboundKind;
  mid: string;
  sender_igsid: string;
  recipient_igid: string;
  timestamp_ms: number;
  text: string | null;
  /** For images: the Meta CDN URL — download IMMEDIATELY, never persist. */
  image_url: string | null;
  quick_reply_payload: string | null;
  unsupported_hint: string | null; // e.g. "sticker" | "video" | "audio" | "gif"
}

// --- QStash worker payloads ---
export type WorkerKind = "ingest" | "message" | "finalize-photos" | "publish" | "poll-container";

export interface IngestPayload {
  kind: "ingest";
  message: NormalizedInbound;
  /**
   * Download-retry attempt (0-based). Absent on the webhook's first delivery.
   * When the CDN download fails transiently, handleImage re-enqueues itself
   * with attempt+1 (max 2) instead of dropping the photo — a slow cold
   * function must not silently lose a burst photo (2026-11-23: 3 photos sent,
   * only 1 survived in lst_84dd9f3355b3).
   */
  attempt?: number | undefined;
}
export interface MessagePayload {
  kind: "message";
  igsid: string;
  mid: string;
  /**
   * Ingest sets this when a photo-first seller is over the daily listing
   * limit: the photo was dropped (no listing created) and the message worker
   * should send the polite limit reply instead of routing the image inbound
   * (which it otherwise ignores).
   */
  limit_reply?: boolean | undefined;
}
export interface FinalizePhotosPayload {
  kind: "finalize-photos";
  listing_id: string;
  photo_at: string; // ISO of the photo that armed the timer; skip if last_photo_at differs
  /**
   * ISO of the last user activity (photo or text) when this run was armed.
   * Burst-combine (2026-11-23): a details text re-arms finalize with a fresh
   * activity_at, so the run that started before the text skips itself and
   * extraction waits for the whole burst (photos + text) to settle.
   * Absent on old in-flight jobs — those fall back to the photo_at guard.
   */
  activity_at?: string | undefined;
  /**
   * How many times this finalize was re-armed by activity arriving during
   * extraction (see handleFinalizePhotos). Capped at 4 — after that the run
   * proceeds with the data it extracted rather than looping forever.
   */
  rearm?: number | undefined;
  /**
   * Retry attempt (0-based). Absent on the first run. On a transient failure
   * finalize re-enqueues itself with attempt+1 (max 2) instead of failing
   * closed at once — a Gemini 503 spike must not strand a listing in review
   * with nothing extracted (2026-11-23: Nina's listing, lst_a5fa2b817b16).
   */
  attempt?: number | undefined;
  /**
   * Burst fix (2026-11-24): how many times this run has waited for
   * in-flight photo downloads to land before extracting. Capped — after
   * the cap the run proceeds anyway and the 4b check routes to REVIEW if
   * photos arrived during extraction, so a stuck download can never
   * strand a listing forever.
   */
  inflight_waits?: number | undefined;
}
export interface PublishPayload {
  kind: "publish";
  listing_id: string;
}
export interface PollContainerPayload {
  kind: "poll-container";
  listing_id: string;
  container_id: string;
  role: "child" | "parent";
  attempt: number;
}
export type WorkerPayload =
  | IngestPayload
  | MessagePayload
  | FinalizePhotosPayload
  | PublishPayload
  | PollContainerPayload;

/**
 * Item boundary (2026-11-28): a listing that already holds ≥2 photos and
 * a details dump is a complete submission. New material arriving after a
 * quiet gap belongs to the seller's NEXT item — merging it would produce
 * a "bundle" of separate items (Nina's three items became one listing).
 * Material inside the gap is still burst-combined into the same listing.
 */
export const ITEM_BOUNDARY_GAP_MS = 60_000;

export function isItemBoundary(listing: ListingDoc, nowIso: string): boolean {
  if (listing.status !== "DRAFT" && listing.status !== "NEEDS_INFO") return false;
  if (!listing.details_received_at) return false;
  if ((listing.photos?.length ?? 0) < 2) return false;
  const detailsMs = Date.parse(listing.details_received_at);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(detailsMs) || Number.isNaN(nowMs)) return false;
  return nowMs - detailsMs > ITEM_BOUNDARY_GAP_MS;
}
