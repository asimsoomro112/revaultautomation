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
}
export interface MessagePayload {
  kind: "message";
  igsid: string;
  mid: string;
}
export interface FinalizePhotosPayload {
  kind: "finalize-photos";
  listing_id: string;
  photo_at: string; // ISO of the photo that armed the timer; skip if last_photo_at differs
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
