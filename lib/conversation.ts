/**
 * Conversation engine — Phase 2.
 *
 * Pure state-machine helpers (canTransition, detectLang, isHumanKeyword,
 * parseQuickReplyPayload, isWithinWindow, nextQuestion, readyForConfirm,
 * coerceFieldValue, matchTypedAnswer) are fully testable without Firebase.
 * The async handlers (handleMessage; handleFinalizePhotos lives in ./finalize)
 * take an injected `Deps` port whose db shape mirrors lib/db.ts (Phase 1),
 * so tests use in-memory fakes and the Next.js routes wire the real modules.
 *
 * Dialogue states: IDLE → COLLECTING → NEEDS_INFO → CONFIRM → (submit/cancel) → IDLE.
 */
import { isItemBoundary } from "./types";
import type {
  AdminSettings,
  Condition,
  ConversationDoc,
  ConversationState,
  ExtractedItem,
  Lang,
  ListingDoc,
  MessagePayload,
  NormalizedInbound,
  WorkerKind,
  WorkerPayload,
} from "./types";
import type { GeminiClient, VisionResult } from "./gemini";
import { MetaApiError, type MetaClient, type QuickReply, type SendMessageOpts } from "./meta";
import type { AlertOpts } from "./telegram";
import {
  buyerFaqReply,
  cancelReply,
  collectingAck,
  confirmNudge,
  confirmPreviewText,
  consentQuickReplies,
  consentText,
  helpText,
  humanHandoffReply,
  listingLimitReply,
  photoCheckHoldReply,
  questionForField,
  type QuestionSpec,
  reviewHoldReply,
  sellerGreeting,
  spamWarning,
  submittedReply,
  unsupportedReply,
} from "./prompts";
import { log, redactPII } from "./log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fields that must be non-null (plus ≥2 photos) before CONFIRM. */
export const REQUIRED_FIELDS = ["category", "size", "condition", "price_pkr", "city"] as const;

/** >N inbound messages in a rolling hour → warn once, then ignore. */
export const SPAM_MAX_PER_HOUR = 12;

const WINDOW_MS = 24 * 3600 * 1000;

/** Priority order when several fields are missing (photos first — no photos, no listing). */
const QUESTION_PRIORITY = ["photos", "category", "condition", "size", "price_pkr", "city", "gender", "caption"] as const;

// ---------------------------------------------------------------------------
// Pure: state machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  IDLE: ["IDLE", "COLLECTING"],
  COLLECTING: ["COLLECTING", "NEEDS_INFO", "CONFIRM", "IDLE"],
  NEEDS_INFO: ["NEEDS_INFO", "CONFIRM", "IDLE"],
  CONFIRM: ["CONFIRM", "NEEDS_INFO", "IDLE"],
};

/** True if the dialogue may move from `from` to `to` (no regressions). */
export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Set state through the guarded transition; logs + refuses illegal jumps. */
export function setConversationState(convo: ConversationDoc, to: ConversationState): boolean {
  if (canTransition(convo.state, to)) {
    convo.state = to;
    return true;
  }
  log.warn("conversation.illegal_transition", { from: convo.state, to, igsid: convo.igsid });
  return false;
}

// ---------------------------------------------------------------------------
// Pure: language detection
// ---------------------------------------------------------------------------

const URDU_SCRIPT_RE = /[؀-ۿﭐ-﷿ﹰ-﻿]/;
const ROMAN_MARKERS_RE =
  /\b(hai|hain|ho|kya|ka|ki|ke|ko|se|mein|nahi|nahin|aap|tum|yeh|ye|woh|kitna|kitne|kitni|chahiye|bhej|bhejo|bhejen|dein|dena|karo|karen|karein|wala|wali|walay|acha|achha|theek|shukriya|kaise|kese|batao|bataein|bataen|tasveer|kimat|qimat|daam|meri|mera|mere|apki|aapki|apna|salam|assalam|walaikum|shukria|meherbani|zara|thoda|thora|bohat|bahut|zyada|kam|aur|lekin|magar|agar|toh|bhi|jee|han|haan|price|size|buy|sell|order|booking|advance|delivery|cod)\b/i;

/**
 * Detect the reply language from user texts.
 * Urdu script → 'ur'; roman-urdu markers → 'roman'; otherwise 'en'.
 * Empty input defaults to 'roman' (the friendly default).
 */
export function detectLang(texts: string[]): Lang {
  const joined = texts.join(" ").trim();
  if (!joined) return "roman";
  if (URDU_SCRIPT_RE.test(joined)) return "ur";
  if (ROMAN_MARKERS_RE.test(joined)) return "roman";
  return "en";
}

// ---------------------------------------------------------------------------
// Pure: human handoff keyword
// ---------------------------------------------------------------------------

// Handoff intent needs a person-to-talk-to phrasing, not just the word:
// The hai/hain/ho branch must NOT require a literal "?" — "koi banda hai"
// (no question mark) still asks for a person. But a BARE "admi/banda/insan
// hai" (no "koi", no "?") is a plausible terse answer to the gender question
// "Yeh kis ke liye hai?" — so the no-"?" form requires the "koi" prefix,
// and the bare form requires the question mark. One false positive here
// permanently mutes the seller (human_needed is sticky, never cleared).
// (Fix #27 over-corrected the other way; re-audit Lane C NEW-5, 2026-11-24.)
const HUMAN_RE =
  /\bhuman\b|real\s*person|asli\s+(banda|insan)|operator\s*(se)?\s*baat|(insan|banda|admi)\s*(se\s*)?baat|((koi\s+)(insan|banda|admi)\s+(hai|hain|ho)|(insan|banda|admi)\s+(hai|hain|ho)\s*\?)|(insan|banda|admi)\s+chahiye|انسان\s*(سے\s*)?بات|کوئی\s*(انسان|بندہ)\s*(ہے|ہیں|ہو)|(انسان|بندہ)\s*چاہیے/i;

/** True if the text asks for a human (English + Roman-Urdu variants). */
export function isHumanKeyword(text: string): boolean {
  return HUMAN_RE.test(text);
}

// ---------------------------------------------------------------------------
// Pure: quick-reply payloads
// ---------------------------------------------------------------------------

export type QuickReplyAction = "consent.post" | "consent.edit" | "consent.cancel" | "info.answer";

export interface ParsedQuickReply {
  action: QuickReplyAction;
  /** For info.answer: "<field>:<value>", e.g. "condition:like_new". */
  value?: string;
}

/**
 * Parse a quick_reply payload. Payloads we send:
 *   consent:post | consent:edit | consent:cancel | info:<field>:<value>
 * Returns null for unknown payloads.
 */
export function parseQuickReplyPayload(payload: string): ParsedQuickReply | null {
  const p = payload.trim();
  if (p === "consent:post") return { action: "consent.post" };
  if (p === "consent:edit") return { action: "consent.edit" };
  if (p === "consent:cancel") return { action: "consent.cancel" };
  const m = /^info:([a-z_]+):(.+)$/.exec(p);
  if (m) return { action: "info.answer", value: `${m[1]}:${m[2]}` };
  return null;
}

// ---------------------------------------------------------------------------
// Pure: 24h messaging window
// ---------------------------------------------------------------------------

/**
 * True if we may still send to the user (a user message arrived <24h ago).
 * `null` (never heard from the user) → false: no anchor, no send.
 * Exactly 24h → closed.
 */
export function isWithinWindow(lastUserMsgAt: string | null, nowMs: number = Date.now()): boolean {
  if (!lastUserMsgAt) return false;
  const ts = Date.parse(lastUserMsgAt);
  if (Number.isNaN(ts)) return false;
  return nowMs - ts < WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Pure: NEEDS_INFO question selection
// ---------------------------------------------------------------------------

/**
 * Pick the highest-priority missing field and build its question
 * (quick replies for enum fields + typed fallback line for desktop users
 * where quick replies don't render).
 */
export function nextQuestion(missing: string[], lang: Lang = "roman", photosHave = 0): QuestionSpec {
  const field = QUESTION_PRIORITY.find((f) => missing.includes(f)) ?? missing[0] ?? "category";
  return questionForField(field, lang, photosHave);
}

/** Guard for the CONFIRM step: all REQUIRED_FIELDS set + ≥2 photos. */
export function readyForConfirm(listing: ListingDoc): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (listing.photos.length < 2) missing.push("photos");
  const e = listing.extracted;
  for (const f of REQUIRED_FIELDS) {
    const v = e?.[f as keyof ExtractedItem];
    if (v === null || v === undefined || v === "") missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Pure: typed-answer coercion (desktop fallback for quick replies)
// ---------------------------------------------------------------------------

export type CoercedValue = { ok: true; value: string | number } | { ok: false };

const CONDITION_ALIASES: Array<[RegExp, Condition]> = [
  [/like[\s_-]?new|10\s*\/\s*10|barely used/i, "like_new"],
  [/\bnew\b/i, "new"],
  [/\bgood\b|used/i, "good"],
  [/\bfair\b|\bok\b|average/i, "fair"],
];

export function mapCondition(text: string): Condition | null {
  for (const [re, c] of CONDITION_ALIASES) if (re.test(text)) return c;
  return null;
}

export function mapGender(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bwom(e|a)n\b|female|larki\w*|aurat|ladies/i.test(t)) return "women";
  if (/\bm(e|a)n\b|male|lark\w*|mard|gents/i.test(t)) return "men";
  if (/unisex/i.test(t)) return "unisex";
  return null;
}

/** Coerce free text into a field value; {ok:false} when unparseable. */
export function coerceFieldValue(field: string, raw: string): CoercedValue {
  const text = raw.trim();
  if (!text) return { ok: false };
  switch (field) {
    case "price_pkr": {
      if (/-\s*\d/.test(text)) return { ok: false }; // negatives are never valid prices
      // "2k" / "1.5k" / "2k PKR" → thousands. Must run before the digit-strip
      // below, which would read "2k" as 2 (2026-11-23: Nina's "Discounted
      // price: 2k" would have become Rs 2).
      const kMatch = /^([\d.,]+)\s*k\b/i.exec(text);
      if (kMatch) {
        const rawNum = kMatch[1];
        if (!rawNum) return { ok: false };
        const n = parseFloat(rawNum.replace(/,/g, ""));
        if (Number.isNaN(n) || n <= 0 || n * 1000 > 100_000_000) return { ok: false };
        return { ok: true, value: Math.round(n * 1000) };
      }
      const digits = text.replace(/[^\d]/g, "");
      const n = parseInt(digits, 10);
      if (!digits || Number.isNaN(n) || n <= 0 || n > 100_000_000) return { ok: false };
      return { ok: true, value: n };
    }
    case "condition": {
      const c = mapCondition(text);
      return c ? { ok: true, value: c } : { ok: false };
    }
    case "category":
      return { ok: true, value: text.toLowerCase().replace(/[\s_-]+t[\s_-]*shirt/, "tshirt") };
    case "gender": {
      const g = mapGender(text);
      return g ? { ok: true, value: g } : { ok: false };
    }
    case "size":
      return { ok: true, value: text.toUpperCase() };
    case "defects":
      return { ok: true, value: text };
    default:
      return { ok: true, value: text };
  }
}

/** Match a typed answer ("2", "like new") against quick-reply options. */
export function matchTypedAnswer(text: string, options: QuickReply[]): string | null {
  const t = text.trim().toLowerCase();
  const idx = parseInt(t, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
    const payload = options[idx - 1]?.payload;
    const m = payload ? /^info:[a-z_]+:(.+)$/.exec(payload) : null;
    return m?.[1] ?? null;
  }
  for (const o of options) {
    const title = o.title.toLowerCase();
    const m = /^info:[a-z_]+:(.+)$/.exec(o.payload);
    if (t === title || t.includes(title) || (m?.[1] && (t === m[1] || t.includes(m[1])))) return m?.[1] ?? null;
  }
  return null;
}

/** Apply a coerced answer to the listing's extracted data (confidence → 1.0). */
export function applyFieldValue(listing: ListingDoc, field: string, value: string | number): void {
  if (!listing.extracted) listing.extracted = blankExtracted();
  const e = listing.extracted;
  if (field === "caption") {
    listing.caption = String(value);
  } else if (field === "price_pkr") {
    e.price_pkr = Number(value);
  } else if (field === "condition") {
    e.condition = value as Condition;
  } else if (
    field === "category" ||
    field === "gender" ||
    field === "brand" ||
    field === "color" ||
    field === "size" ||
    field === "city" ||
    field === "measurements" ||
    field === "title"
  ) {
    (e as unknown as Record<string, unknown>)[field] = String(value);
  } else if (field === "defects") {
    e.defects = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    (e as unknown as Record<string, unknown>)[field] = value;
  }
  e.confidence[field] = 1.0;
}

export function blankExtracted(): ExtractedItem {
  return {
    title: "",
    category: null,
    gender: null,
    brand: null,
    color: null,
    size: null,
    condition: null,
    price_pkr: null,
    city: null,
    defects: [],
    measurements: null,
    confidence: {},
  };
}

// ---------------------------------------------------------------------------
// Pure: multi-field details dump parsing (NEEDS_INFO)
// ---------------------------------------------------------------------------

export interface ParsedDetail {
  field: string;
  rawValue: string;
}

/**
 * Sellers answer a missing-field question with ONE multi-line dump
 * ("Brand: …\nSize: …\nDiscounted price: 2k\nCity: …") instead of one field
 * at a time. The old NEEDS_INFO path coerced the whole blob as the answer to
 * the single pending field and threw the rest away (2026-11-23: Nina's dump
 * arrived after finalize and was lost). Parse every recognizable "Key: value"
 * line into a field; unknown keys (Dc, Shoulder…) are skipped.
 */
// Every alternative is start-anchored: an unanchored branch (e.g. the bare
// "type" in /^categor(y|ies)|type|qisam/i) matched ANYWHERE in the key, so
// "Delivery type: TCS" corrupted the category with the courier name and
// "Pickup location: Karachi" overwrote the city. An unrecognised key is
// skipped and the field stays missing (the bot asks again) — a wrong value
// that could go live is worse than a missing one.
const DETAIL_KEY_TO_FIELD: Array<[RegExp, string]> = [
  [/^discount(ed)?\s+price/i, "price_pkr"],
  [/^(sale\s+price|price|qeemat|qimat|daam|rate)\b/i, "price_pkr"],
  [/^original\s+price/i, "__original_price"],
  [/^brand\b/i, "brand"],
  [/^size\b/i, "size"],
  [/^(condition|halat)\b/i, "condition"],
  [/^(city|sheher|shehr|location)\b/i, "city"],
  [/^(measurements?|naap)\b/i, "measurements"],
  [/^(length|width|chest|shoulder|sleeve|waist)\b/i, "measurements"],
  [/^(categor(y|ies)|type|qisam)\b/i, "category"],
  [/^(colou?r|rang)\b/i, "color"],
  [/^gender\b/i, "gender"],
  [/^(defects?|damage|kharabi)\b/i, "defects"],
];

export function parseDetailsDump(text: string): ParsedDetail[] {
  const out: ParsedDetail[] = [];
  let originalPrice: ParsedDetail | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:]{1,30}?)\s*[:\-–]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = (m[1] ?? "").trim();
    const value = (m[2] ?? "").trim();
    if (!key || !value) continue;
    const hit = DETAIL_KEY_TO_FIELD.find(([re]) => re.test(key));
    if (!hit) continue;
    const field = hit[1];
    if (field === "__original_price") {
      originalPrice = { field: "price_pkr", rawValue: value };
      continue;
    }
    if (out.some((d) => d.field === field)) continue; // first wins per field
    out.push({ field, rawValue: value });
  }
  // The selling price is the discounted one; fall back to the original price
  // only when no discounted/sale price was given.
  if (!out.some((d) => d.field === "price_pkr") && originalPrice) out.push(originalPrice);
  return out;
}

// ---------------------------------------------------------------------------
// Deps port — db shape mirrors lib/db.ts (Phase 1); fakes in tests
// ---------------------------------------------------------------------------

export interface DbPort {
  getOrCreateConversation(igsid: string): Promise<ConversationDoc>;
  saveConversation(igsid: string, patch: Partial<ConversationDoc>): Promise<ConversationDoc>;
  getListing(id: string): Promise<ListingDoc | null>;
  saveListing(id: string, patch: Partial<ListingDoc>): Promise<void>;
  /**
   * Transactional read-modify-write (see lib/db.ts mutateListing). Any write
   * whose new value derives from the current doc (chat_text, extracted,
   * photos) MUST use this — a getListing + saveListing pair loses updates
   * when burst messages process concurrently.
   */
  mutateListing: <T>(
    id: string,
    mutate: (doc: ListingDoc) => { patch: Partial<ListingDoc>; result: T },
  ) => Promise<T>;
  /**
   * Transactional find-or-create of the sender's active DRAFT/NEEDS_INFO
   * listing (see lib/db.ts getOrCreateActiveListing). The daily limit is
   * enforced inside that transaction (maxPerDay): when the seller is over
   * the limit and no active listing exists, it returns
   * { listing: null, limitReached: true } and creates nothing.
   */
  getOrCreateActiveListing: (
    igsid: string,
    nowIso: string,
    maxPerDay?: number,
  ) => Promise<{
    listing: ListingDoc | null;
    isNew: boolean;
    limitReached?: boolean;
    listingsToday?: number;
    listingsDay?: string;
    closedListing?: { id: string; activity_at: string; photo_at: string };
  }>;
  createListing(doc: ListingDoc): Promise<void>;
  appendListingEvent(listingId: string, event: { type: string; at?: string; [k: string]: unknown }): Promise<void>;
  getAdminSettings(): Promise<AdminSettings>;
  /** Write a perceptual hash into the duplicate-detection index. */
  recordPhash(phash: string, listingId: string): Promise<void>;
  newListingId(): string;
  blankListingDoc(id: string, sellerIgsid: string, nowIso: string): ListingDoc;
}

export interface EnqueueOpts {
  delaySec?: number;
  notBefore?: number;
  deduplicationId?: string;
}

export interface Deps {
  db: DbPort;
  gemini: GeminiClient;
  meta: MetaClient;
  notifyAdmin: (text: string, opts?: AlertOpts) => Promise<void>;
  enqueueWorker: (route: WorkerKind, payload: WorkerPayload, opts?: EnqueueOpts) => Promise<void>;
  /** Phase 3's buildCaption — injected so tests can stub it. */
  buildCaption: (extracted: ExtractedItem, lang: Lang) => Promise<string>;
  now: () => string;
  maxListingsPerSellerPerDay: number;
  /** Seconds finalize-photos waits after the last burst activity (env PHOTO_DEBOUNCE_SECONDS). */
  photoDebounceSeconds: number;
}

/** Persist the mutated conversation doc (db API is patch-based). */
async function persistConvo(deps: Deps, convo: ConversationDoc): Promise<void> {
  await deps.db.saveConversation(convo.igsid, { ...convo });
}

/**
 * Backfill Phase-2 fields on docs that predate them (defensive; new docs
 * already carry them via blankConversation/blankListingDoc).
 */
function normalizeConversation(convo: ConversationDoc): void {
  if (convo.user_msg_total === undefined) convo.user_msg_total = 0;
  if (convo.last_processed_mid === undefined) convo.last_processed_mid = null;
  if (convo.msg_count_1h === undefined) convo.msg_count_1h = 0;
}

function normalizeListing(listing: ListingDoc): void {
  if (listing.chat_text === undefined) listing.chat_text = "";
  if (!Array.isArray(listing.missing)) listing.missing = [];
  if (!Array.isArray(listing.photos)) listing.photos = [];
  if (listing.last_activity_at === undefined) listing.last_activity_at = null;
}

// ---------------------------------------------------------------------------
// Send helper: never send outside the 24h window
// ---------------------------------------------------------------------------

export async function sendSafe(
  deps: Deps,
  convo: ConversationDoc,
  opts: SendMessageOpts,
): Promise<{ sent: boolean; messageId?: string }> {
  if (!isWithinWindow(convo.last_user_msg_at, Date.parse(deps.now()))) {
    convo.window_open = false;
    await persistConvo(deps, convo);
    log.warn("message.window_closed_skip_send", { igsid: convo.igsid });
    return { sent: false };
  }
  try {
    const res = await deps.meta.sendMessage(convo.igsid, opts);
    return { sent: true, messageId: res.messageId };
  } catch (err) {
    if (err instanceof MetaApiError && err.isWindowError()) {
      convo.window_open = false;
      await persistConvo(deps, convo);
      log.warn("message.window_error_from_meta", { igsid: convo.igsid });
    } else if (err instanceof MetaApiError && err.isRecipientError()) {
      // Config bug, not a closed window: the recipient id (IG_USER_ID /
      // seller IGSID) is wrong. Alert the admin — silently swallowing it
      // would look like the seller never got a reply. The alert itself is
      // best-effort: sendSafe never throws.
      log.error("message.recipient_error", { igsid: convo.igsid, subcode: 2534014 });
      try {
        await deps.notifyAdmin(
          `⚠️ IG send failed (subcode 2534014, bad recipient id) for seller ${convo.igsid} — check IG_USER_ID / the seller's app-scoped id.`,
          { igsid: convo.igsid },
        );
      } catch (notifyErr) {
        log.warn("message.recipient_alert_failed", {
          igsid: convo.igsid,
          err: String(notifyErr).slice(0, 160),
        });
      }
    } else {
      log.error("message.send_failed", { igsid: convo.igsid, error: err instanceof Error ? err.message : String(err) });
    }
    return { sent: false };
  }
}

/** Pending-question source: the stored missing list wins — readyForConfirm
 * never lists "caption" (it is generated, not extracted), so the edit
 * flow's ["caption"] would otherwise resolve to the "category" fallback
 * and the seller's answer would land on the wrong field. */
function pendingMissing(listing: ListingDoc): string[] {
  const stored = listing.missing ?? [];
  return stored.length > 0 ? stored : readyForConfirm(listing).missing;
}

/** True when the listing has a photo that never went through finalize
 * (ingest leaves phash:""; finalize fills it during extraction). Submitting
 * such a listing would publish an unexamined photo. */
function hasUnprocessedPhoto(listing: ListingDoc): boolean {
  return listing.photos.some((p) => !p.phash);
}

/** Defer submission until finalize has checked every photo: re-arm it with
 * the fresh activity (the answer's bump invalidated the photo's own armed
 * finalize), stay in NEEDS_INFO, and tell the seller to wait. The re-armed
 * finalize submits the listing to admin review once checked — no deadlock,
 * since finalize's own submission does not check phash.
 *
 * The LISTING status must move to NEEDS_INFO too, not just the convo: a
 * stale quick-reply tap can reach this defer while the listing is CONFIRM
 * (a dhash-failed photo leaves phash "" and finalize does not gate on it),
 * and CONFIRM is not in finalize's PROCESSABLE set — the re-armed finalize
 * would skip on status and the hold would never resolve, with no DM and no
 * alert (2026-11-24 re-audit Lane C NEW-1). On the normal path the listing
 * is already NEEDS_INFO, so the patch is a no-op. */
async function deferConfirmForPhotoCheck(
  deps: Deps,
  convo: ConversationDoc,
  listing: ListingDoc,
  nowIso: string,
): Promise<void> {
  await rearmFinalizeForText(deps, listing, nowIso);
  if (listing.status !== "NEEDS_INFO") {
    await deps.db.mutateListing(listing.id, () => ({
      patch: { status: "NEEDS_INFO" },
      result: undefined,
    }));
  }
  setConversationState(convo, "NEEDS_INFO");
  await persistConvo(deps, convo);
  await sendSafe(deps, convo, { text: photoCheckHoldReply(convo.lang) });
}

// ---------------------------------------------------------------------------
// Shared: move a complete listing to CONFIRM (message worker + finalize worker)
// ---------------------------------------------------------------------------

export async function moveToConfirm(deps: Deps, convo: ConversationDoc, listing: ListingDoc): Promise<void> {
  if (!listing.extracted) throw new Error("moveToConfirm: listing has no extracted data");
  const caption = await deps.buildCaption(listing.extracted, convo.lang);
  // Narrow patch, not a full-doc save: a concurrent photo/chat append must
  // never be clobbered by this status transition.
  await deps.db.saveListing(listing.id, { caption, status: "CONFIRM" });
  listing.caption = caption;
  listing.status = "CONFIRM";
  await deps.db.appendListingEvent(listing.id, { type: "confirm", caption_chars: caption.length });
  setConversationState(convo, "CONFIRM");
  await persistConvo(deps, convo);
  const preview = confirmPreviewText(listing.extracted, caption, convo.lang);
  await sendSafe(deps, convo, {
    text: `${preview}\n\n${consentText(convo.lang)}`,
    quickReplies: consentQuickReplies(),
  });
}

/**
 * Hand the listing to the admin (Asim, 2026-11-28): once the customer has
 * sent pictures + details, the rest is the admin's call — approve or
 * reject in /admin. The bot does NOT interrogate the customer for missing
 * fields and does NOT ask for a seller confirm tap: a complete listing
 * lands in the queue as SUBMITTED, an incomplete one as NEEDS_REVIEW with
 * its missing fields recorded for the admin. Either way the conversation
 * is released (IDLE, no active listing) so the customer's next post starts
 * a fresh listing instead of being folded into this one.
 */
/**
 * Release the conversation only if it still points at this listing. With
 * item-boundary splits, the seller may already be collecting the next
 * item while this listing finalizes — clearing the pointer then would
 * orphan the new item.
 */
export async function releaseConversationIfActive(
  deps: Deps,
  convo: ConversationDoc,
  listingId: string,
): Promise<void> {
  const fresh = await deps.db.getOrCreateConversation(convo.igsid);
  if (fresh.active_listing_id !== listingId) return;
  setConversationState(convo, "IDLE");
  convo.active_listing_id = null;
  await deps.db.saveConversation(convo.igsid, { state: convo.state, active_listing_id: null });
}

export async function submitToAdminReview(
  deps: Deps,
  convo: ConversationDoc,
  listing: ListingDoc,
  opts: { status: "SUBMITTED" | "NEEDS_REVIEW"; missing: string[]; keepCaption?: boolean; note?: string },
): Promise<void> {
  const caption =
    opts.keepCaption && listing.caption
      ? listing.caption
      : listing.extracted
        ? await deps.buildCaption(listing.extracted, convo.lang)
        : (listing.caption ?? "");
  // Narrow patch, not a full-doc save: a concurrent photo/chat append must
  // never be clobbered by this status transition.
  await deps.db.saveListing(listing.id, { caption, status: opts.status, missing: opts.missing });
  listing.caption = caption;
  listing.status = opts.status;
  listing.missing = opts.missing;
  if (opts.status === "NEEDS_REVIEW") {
    await deps.db.appendListingEvent(listing.id, {
      type: "needs_review",
      note: (opts.note ?? `incomplete listing sent to admin review — missing: ${opts.missing.join(", ") || "none"}`).slice(0, 300),
    });
  } else {
    await deps.db.appendListingEvent(listing.id, { type: "submitted", caption_chars: caption.length });
  }
  await releaseConversationIfActive(deps, convo, listing.id);
  if (opts.status === "NEEDS_REVIEW") {
    await deps.notifyAdmin(
      `🔍 Review needed — listing ${listing.id} (seller ${listing.seller_igsid}): missing ${opts.missing.join(", ") || "none"}`,
      { listingId: listing.id, igsid: listing.seller_igsid },
    );
    await sendSafe(deps, convo, { text: reviewHoldReply(convo.lang) });
  } else {
    await sendSafe(deps, convo, { text: submittedReply(convo.lang) });
  }
}

// ---------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------

async function activeListing(deps: Deps, convo: ConversationDoc): Promise<ListingDoc | null> {
  if (!convo.active_listing_id) return null;
  const listing = await deps.db.getListing(convo.active_listing_id);
  if (listing) normalizeListing(listing);
  return listing;
}

function appendChat(existing: string, text: string): string {
  const next = existing ? `${existing}\n${text}` : text;
  return next.length > 4000 ? next.slice(next.length - 4000) : next;
}

/**
 * Burst-combine: a details text arriving on a listing that already has
 * photos re-arms the finalize timer, so extraction waits for the whole
 * burst (photos + text) instead of running on the photos alone — 2026-11-23
 * the seller's text arrived after the photos and finalize extracted without
 * it. No photos yet → nothing to finalize; the photo's own ingest arms it.
 * The caller already bumped last_activity_at in the same mutate, so a
 * finalize that started before this text skips itself on the activity guard.
 */
/**
 * Item boundary for texts: a fresh details dump arriving after the quiet
 * gap on a listing that already has photos + details starts the NEXT
 * item. The finished listing is finalized into the admin queue and the
 * dump lands on a fresh listing.
 */
async function splitItemIfBoundary(
  deps: Deps,
  convo: ConversationDoc,
  listing: ListingDoc,
  text: string,
  nowIso: string,
): Promise<ListingDoc> {
  if (parseDetailsDump(text).length < 2 || !isItemBoundary(listing, nowIso)) return listing;
  const ensured = await ensureActiveListing(deps, convo, nowIso);
  if (ensured.listing && ensured.listing.id !== listing.id) setConversationState(convo, "COLLECTING");
  return ensured.listing ?? listing;
}

async function rearmFinalizeForText(deps: Deps, listing: ListingDoc, nowIso: string): Promise<void> {
  // Re-read fresh: callers pass a snapshot read BEFORE their own
  // last_activity_at bump, so a photo appended between that read and this
  // call is invisible to the snapshot (photos.length === 0 → early return)
  // while the bump already invalidated the photo's own armed finalize — the
  // listing would sit unextracted forever, no DM, no alert (2026-11-24
  // re-audit Lane C M5). The fresh read closes the straddle: the photo's
  // append either precedes it (seen → arm F2) or follows it (the photo's
  // own finalize then runs, since its append re-bumps activity last).
  const fresh = (await deps.db.getListing(listing.id)) ?? listing;
  if (fresh.photos.length === 0) return;
  await deps.enqueueWorker(
    "finalize-photos",
    {
      kind: "finalize-photos",
      listing_id: listing.id,
      photo_at: fresh.last_photo_at ?? nowIso,
      activity_at: nowIso,
    },
    {
      delaySec: deps.photoDebounceSeconds,
      deduplicationId: `finalize-${listing.id}-${nowIso}`,
    },
  );
}

/**
 * Ensure the conversation has an active DRAFT-ish listing. Shared with the
 * ingest worker (Phase 1): call this when photos arrive with no active listing.
 * Returns { listing: null } when the seller hit the daily listing limit.
 *
 * Creation is transactional (getOrCreateActiveListing): two concurrent first
 * messages must not each create their own listing and split one seller's
 * photos across two listings.
 */
export async function ensureActiveListing(
  deps: Deps,
  convo: ConversationDoc,
  nowIso: string,
): Promise<{ listing: ListingDoc | null; isNew: boolean }> {
  if (convo.active_listing_id) {
    const existing = await activeListing(deps, convo);
    if (existing && (existing.status === "DRAFT" || existing.status === "NEEDS_INFO" || existing.status === "CONFIRM")) {
      if (!isItemBoundary(existing, nowIso)) {
        if (convo.state === "IDLE") setConversationState(convo, "COLLECTING");
        return { listing: existing, isNew: false };
      }
      // Item boundary: fall through — getOrCreate closes the finished
      // item and starts the next one. The pointer stays set so the
      // transaction can see (and close) the finished listing.
    } else {
      convo.active_listing_id = null; // stale pointer (submitted/rejected/…)
    }
  }
  // The daily limit (incl. the midnight-PKT rollover) is enforced atomically
  // inside getOrCreateActiveListing's transaction — it used to live here,
  // which left the photo-first path unenforced: ingest called getOrCreate
  // directly and never touched listings_today, so a photo-first seller could
  // submit unlimited listings (2026-11-24 re-audit Lane C N-H1).
  const { listing, isNew, listingsToday, listingsDay, closedListing } = await deps.db.getOrCreateActiveListing(
    convo.igsid,
    nowIso,
    deps.maxListingsPerSellerPerDay,
  );
  if (closedListing) {
    await deps.enqueueWorker(
      "finalize-photos",
      {
        kind: "finalize-photos",
        listing_id: closedListing.id,
        photo_at: closedListing.photo_at,
        activity_at: closedListing.activity_at,
      },
      { deduplicationId: `finalize-${closedListing.id}-${closedListing.activity_at}` },
    );
  }
  if (!listing) return { listing: null, isNew: false }; // limit reached — caller sends the limit reply
  convo.active_listing_id = listing.id;
  convo.intent = "SELLER_SUBMIT";
  if (isNew) {
    // Keep the in-memory convo consistent with the transaction's counter
    // bump — the caller full-saves this doc afterwards, and a stale value
    // here would clobber the bump.
    if (listingsToday !== undefined) convo.listings_today = listingsToday;
    if (listingsDay !== undefined) convo.listings_day = listingsDay;
    await deps.db.appendListingEvent(listing.id, { type: "created", source: "dm" });
  }
  if (convo.state === "IDLE") setConversationState(convo, "COLLECTING");
  return { listing, isNew };
}

// ---------------------------------------------------------------------------
// Message worker: handleMessage
// ---------------------------------------------------------------------------

function applySpamWindow(convo: ConversationDoc, nowIso: string): void {
  const nowMs = Date.parse(nowIso);
  const startMs = convo.msg_window_start ? Date.parse(convo.msg_window_start) : NaN;
  if (!convo.msg_window_start || Number.isNaN(startMs) || nowMs - startMs > 3600 * 1000) {
    convo.msg_window_start = nowIso;
    convo.msg_count_1h = 1;
  } else {
    convo.msg_count_1h += 1;
  }
}

export async function handleMessage(
  payload: MessagePayload,
  inbound: NormalizedInbound,
  deps: Deps,
): Promise<{ ok: true }> {
  const { igsid, mid } = payload;
  const nowIso = deps.now();
  const convo = await deps.db.getOrCreateConversation(igsid);
  normalizeConversation(convo);

  // --- spam guard: rolling 1h window ---
  applySpamWindow(convo, nowIso);
  if (convo.msg_count_1h > SPAM_MAX_PER_HOUR) {
    await persistConvo(deps, convo);
    if (convo.msg_count_1h === SPAM_MAX_PER_HOUR + 1) {
      await deps.notifyAdmin(
        `⚠️ Spam guard: seller ${igsid} crossed ${SPAM_MAX_PER_HOUR} msgs/hour — warned once, further messages ignored.`,
        { igsid },
      );
      await sendSafe(deps, convo, { text: spamWarning(convo.lang) });
    } else {
      log.warn("message.ignored_spam", { igsid });
    }
    return { ok: true };
  }

  if (convo.blocked) {
    log.warn("message.blocked_sender", { igsid });
    await persistConvo(deps, convo);
    return { ok: true };
  }

  // --- idempotency: never process the same mid twice ---
  if (convo.last_processed_mid === mid) {
    log.info("message.duplicate_mid", { mid });
    return { ok: true };
  }

  // --- inbound anchors (saved immediately so a concurrent duplicate delivery
  // is deduped) ---
  convo.last_user_msg_at = nowIso;
  convo.window_open = true;
  convo.user_msg_total += 1;
  const prevMid = convo.last_processed_mid;
  convo.last_processed_mid = mid;
  const text = inbound.text?.trim() ?? "";
  if (convo.user_msg_total <= 2 && text) convo.lang = detectLang([text]);
  await persistConvo(deps, convo);

  try {
    // Daily-limit reply for a photo-first seller: ingest enforces the limit
    // atomically in getOrCreateActiveListing and, when the seller is over
    // the limit, enqueues the message worker with limit_reply so the seller
    // hears why their photo was dropped (the message worker otherwise
    // ignores image inbounds entirely).
    if (payload.limit_reply) {
      await sendSafe(deps, convo, { text: listingLimitReply(convo.lang, deps.maxListingsPerSellerPerDay) });
      return { ok: true };
    }
    // --- human handoff keyword: flag + holding reply ONCE per flag ---
    if (text && isHumanKeyword(text)) {
      if (!convo.human_needed) {
        convo.human_needed = true;
        await persistConvo(deps, convo);
        await deps.notifyAdmin(`🙋 Human requested by ${igsid}: "${redactPII(text).slice(0, 140)}"`, { igsid });
        await sendSafe(deps, convo, { text: humanHandoffReply(convo.lang) });
      }
      return { ok: true };
    }
    if (convo.human_needed) {
      log.info("message.skipped_human_needed", { igsid });
      return { ok: true };
    }

    // --- route by inbound kind ---
    if (inbound.kind === "quick_reply" && inbound.quick_reply_payload) {
      await handleQuickReply(deps, convo, inbound.quick_reply_payload, mid, nowIso);
    } else if (inbound.kind === "text" && text) {
      await handleText(deps, convo, text, nowIso);
    } else if (inbound.kind === "unsupported") {
      await persistConvo(deps, convo);
      // At most one video notice per listing, and none when photos are
      // already in — a forwarded batch's video must not re-trigger the
      // "2+ clear photos chahiye" line after every batch (2026-11-28).
      const listing = await activeListing(deps, convo);
      let sendNotice = true;
      if (listing) {
        if (listing.photos.length > 0) {
          sendNotice = false;
        } else {
          sendNotice = await deps.db.mutateListing(listing.id, (doc) => {
            const first = !doc.video_notice_sent;
            return { patch: { video_notice_sent: true }, result: first };
          });
        }
      }
      if (sendNotice) {
        await sendSafe(deps, convo, { text: unsupportedReply(inbound.unsupported_hint ?? "", convo.lang) });
      }
    } else {
      log.info("message.unhandled_kind", { kind: inbound.kind, mid });
    }
  } catch (err) {
    // Transient failure (Gemini / Firestore / Meta): clear the mid anchor so
    // the QStash retry reprocesses this message. Without this, the retry
    // would hit the dup guard above and drop the message forever — the
    // worker 500s, QStash retries, and the anchor says "already done".
    convo.last_processed_mid = prevMid;
    try {
      await persistConvo(deps, convo);
    } catch (persistErr) {
      log.warn("message.anchor_clear_failed", {
        mid,
        err: String(persistErr).slice(0, 160),
      });
    }
    throw err;
  }
  return { ok: true };
}

async function handleText(deps: Deps, convo: ConversationDoc, text: string, nowIso: string): Promise<void> {
  switch (convo.state) {
    case "IDLE": {
      const res = await deps.gemini.classifyIntent(text, []);
      convo.intent = res.intent;
      if (res.confidence >= 0.7) convo.lang = res.lang; // mirror, but don't flip on weak signals
      if (res.intent === "SELLER_SUBMIT") {
        const ensured = await ensureActiveListing(deps, convo, nowIso);
        if (!ensured.listing) {
          await persistConvo(deps, convo);
          await sendSafe(deps, convo, { text: listingLimitReply(convo.lang, deps.maxListingsPerSellerPerDay) });
        } else {
          // Transactional append: a concurrent photo ingest must not lose
          // this text, and this save must not clobber its photos. The
          // activity bump + finalize re-arm are the burst-combine: a text
          // arriving before/after the photos joins the same extraction.
          await deps.db.mutateListing(ensured.listing.id, (doc) => ({
            patch: { chat_text: appendChat(doc.chat_text ?? "", text), last_activity_at: nowIso },
            result: undefined,
          }));
          await rearmFinalizeForText(deps, ensured.listing, nowIso);
          await persistConvo(deps, convo);
          await sendSafe(deps, convo, { text: ensured.isNew ? sellerGreeting(convo.lang) : collectingAck(convo.lang) });
        }
      } else if (res.intent === "BUYER_QUESTION") {
        const settings = await deps.db.getAdminSettings();
        await persistConvo(deps, convo);
        await sendSafe(deps, convo, { text: buyerFaqReply(convo.lang, settings.faq_buyer) });
      } else {
        await persistConvo(deps, convo);
        await sendSafe(deps, convo, { text: helpText(convo.lang) });
      }
      break;
    }
    case "COLLECTING": {
      const listing = await activeListing(deps, convo);
      if (!listing) {
        setConversationState(convo, "IDLE");
        convo.active_listing_id = null;
        await persistConvo(deps, convo);
        await sendSafe(deps, convo, { text: helpText(convo.lang) });
        break;
      }
      // Transactional append (see IDLE branch): burst photos + this text
      // process concurrently, and neither may clobber the other. The
      // activity bump + finalize re-arm are the burst-combine: this text
      // joins the pending extraction instead of arriving too late for it.
      // A fresh details dump after the item-boundary gap instead starts
      // the next item (the finished one is finalized to the admin queue).
      const target = await splitItemIfBoundary(deps, convo, listing, text, nowIso);
      const isDump = parseDetailsDump(text).length >= 2;
      await deps.db.mutateListing(target.id, (doc) => ({
        patch: {
          chat_text: appendChat(doc.chat_text ?? "", text),
          last_activity_at: nowIso,
          ...(isDump ? { details_received_at: nowIso } : {}),
        },
        result: undefined,
      }));
      await rearmFinalizeForText(deps, target, nowIso);
      await persistConvo(deps, convo);
      await sendSafe(deps, convo, { text: collectingAck(convo.lang) });
      break;
    }
    case "NEEDS_INFO": {
      const listing = await activeListing(deps, convo);
      if (!listing) {
        setConversationState(convo, "IDLE");
        convo.active_listing_id = null;
        await persistConvo(deps, convo);
        break;
      }
      // No puchtash (Asim, 2026-11-28): a text here is more details for the
      // pending extraction, never an answer to a bot question. Append it,
      // re-arm finalize, and let extraction + admin review decide — missing
      // fields go to /admin as NEEDS_REVIEW, not back to the customer as
      // questions. The one exception is the legacy caption-edit flow
      // (missing == ["caption"]), where the text IS the seller's caption.
      const missing = pendingMissing(listing);
      if (missing.length === 1 && missing[0] === "caption") {
        await handleInfoAnswer(deps, convo, listing, "caption", text);
        break;
      }
      const target = await splitItemIfBoundary(deps, convo, listing, text, nowIso);
      const isDump = parseDetailsDump(text).length >= 2;
      await deps.db.mutateListing(target.id, (doc) => ({
        patch: {
          chat_text: appendChat(doc.chat_text ?? "", text),
          last_activity_at: nowIso,
          ...(isDump ? { details_received_at: nowIso } : {}),
        },
        result: undefined,
      }));
      await rearmFinalizeForText(deps, target, nowIso);
      await persistConvo(deps, convo);
      await sendSafe(deps, convo, { text: collectingAck(convo.lang) });
      break;
    }
    case "CONFIRM": {
      // Legacy state (finalize no longer creates it): the listing is
      // complete, so hand it to the admin instead of nudging for a confirm
      // tap, then treat this text as the start of whatever comes next.
      const listing = await activeListing(deps, convo);
      if (listing && listing.status === "CONFIRM") {
        await submitToAdminReview(deps, convo, listing, { status: "SUBMITTED", missing: [], keepCaption: true });
        await handleText(deps, convo, text, nowIso);
      } else {
        await persistConvo(deps, convo);
        await sendSafe(deps, convo, { text: confirmNudge(convo.lang), quickReplies: consentQuickReplies() });
      }
      break;
    }
  }
}

async function handleQuickReply(
  deps: Deps,
  convo: ConversationDoc,
  payload: string,
  mid: string,
  nowIso: string,
): Promise<void> {
  const parsed = parseQuickReplyPayload(payload);
  if (!parsed) {
    await persistConvo(deps, convo);
    await sendSafe(deps, convo, { text: helpText(convo.lang) });
    return;
  }
  switch (parsed.action) {
    case "consent.post":
      await handleConsentPost(deps, convo, mid, nowIso);
      break;
    case "consent.cancel":
      await handleConsentCancel(deps, convo);
      break;
    case "consent.edit":
      await handleConsentEdit(deps, convo);
      break;
    case "info.answer": {
      const [field, ...rest] = (parsed.value ?? "").split(":");
      const listing = await activeListing(deps, convo);
      if (!listing || !field) {
        await persistConvo(deps, convo);
        break;
      }
      await handleInfoAnswer(deps, convo, listing, field, rest.join(":"));
      break;
    }
  }
}

async function handleConsentPost(deps: Deps, convo: ConversationDoc, mid: string, nowIso: string): Promise<void> {
  const listing = await activeListing(deps, convo);
  if (!listing || convo.state !== "CONFIRM") {
    await persistConvo(deps, convo);
    return; // stray/duplicate tap — ignore quietly
  }
  const already = listing.status === "SUBMITTED";
  if (!already) {
    const consent = { at: nowIso, message_id: mid };
    // Narrow patch, not a full-doc save (see moveToConfirm).
    await deps.db.saveListing(listing.id, { consent, status: "SUBMITTED" });
    listing.consent = consent;
    listing.status = "SUBMITTED";
    await deps.db.appendListingEvent(listing.id, { type: "consent", at: nowIso, message_id: mid });
    setConversationState(convo, "IDLE");
    convo.active_listing_id = null;
    await persistConvo(deps, convo);
  }
  // Phase 4's publish worker applies PUBLISH_MODE / review / slot logic itself.
  await deps.enqueueWorker("publish", { kind: "publish", listing_id: listing.id });
  if (!already) {
    await sendSafe(deps, convo, { text: submittedReply(convo.lang) });
  }
}

async function handleConsentCancel(deps: Deps, convo: ConversationDoc): Promise<void> {
  const listing = await activeListing(deps, convo);
  if (listing && (convo.state === "CONFIRM" || listing.status === "CONFIRM")) {
    // Narrow patch, not a full-doc save (see moveToConfirm).
    await deps.db.saveListing(listing.id, { status: "REJECTED" });
    listing.status = "REJECTED";
    await deps.db.appendListingEvent(listing.id, { type: "cancelled_by_seller" });
    setConversationState(convo, "IDLE");
    convo.active_listing_id = null;
    await persistConvo(deps, convo);
    await sendSafe(deps, convo, { text: cancelReply(convo.lang) });
    return;
  }
  // Stale tap — the listing was NOT cancelled (already submitted, or
  // deferred for the photo check): do not clear the pointer or tell the
  // seller it was cancelled. Clearing active_listing_id here would strand
  // the listing (moveToConfirm never restores it, so a later "Post it" is
  // silently ignored), and the cancel DM would lie while publish proceeds
  // (2026-11-24 re-audit Lane C NEW-7 / pass-3 NEW-A). Silently ignore,
  // like the other stale consent taps.
  await persistConvo(deps, convo);
}

async function handleConsentEdit(deps: Deps, convo: ConversationDoc): Promise<void> {
  const listing = await activeListing(deps, convo);
  if (!listing || convo.state !== "CONFIRM") {
    await persistConvo(deps, convo);
    return;
  }
  listing.status = "NEEDS_INFO";
  listing.missing = ["caption"];
  // Narrow patch, not a full-doc save (see moveToConfirm).
  await deps.db.saveListing(listing.id, { status: "NEEDS_INFO", missing: ["caption"] });
  setConversationState(convo, "NEEDS_INFO");
  await persistConvo(deps, convo);
  const q = nextQuestion(["caption"], convo.lang, listing.photos.length);
  await sendSafe(deps, convo, { text: q.question });
}

async function handleInfoAnswer(
  deps: Deps,
  convo: ConversationDoc,
  listing: ListingDoc,
  field: string,
  rawValue: string,
): Promise<void> {
  if (field === "photos") {
    // Photos can't be answered by text — and the bot no longer re-asks.
    // The listing goes to the admin as-is; approve/reject is their call.
    await submitToAdminReview(deps, convo, listing, {
      status: "NEEDS_REVIEW",
      missing: readyForConfirm(listing).missing,
    });
    return;
  }
  const coerced = coerceFieldValue(field, rawValue);
  if (!coerced.ok) {
    // Unparseable as that field — keep it as details for extraction instead
    // of interrogating the customer again.
    const nowIso = deps.now();
    await deps.db.mutateListing(listing.id, (doc) => ({
      patch: { chat_text: appendChat(doc.chat_text ?? "", rawValue.trim()), last_activity_at: nowIso },
      result: undefined,
    }));
    await rearmFinalizeForText(deps, listing, nowIso);
    await persistConvo(deps, convo);
    await sendSafe(deps, convo, { text: collectingAck(convo.lang) });
    return;
  }
  // Apply to the FRESH doc inside the transaction: a concurrent photo ingest
  // or second answer must not lose this field (or its photos). The activity
  // bump tells a concurrently-running finalize its extraction is stale.
  const nowIso = deps.now();
  const updated = await deps.db.mutateListing(listing.id, (doc) => {
    normalizeListing(doc);
    applyFieldValue(doc, field, coerced.value);
    doc.missing = (doc.missing ?? []).filter((m) => m !== field);
    doc.chat_text = appendChat(doc.chat_text ?? "", `[${field}] ${rawValue.trim()}`);
    return {
      patch: { extracted: doc.extracted, missing: doc.missing, chat_text: doc.chat_text, caption: doc.caption, last_activity_at: nowIso },
      result: doc,
    };
  });
  const after = readyForConfirm(updated);
  if (after.ok) {
    // A photo that arrived after the last extraction has never been visioned
    // or moderated — submitting now would publish it unexamined.
    if (hasUnprocessedPhoto(updated)) {
      await deferConfirmForPhotoCheck(deps, convo, updated, nowIso);
      return;
    }
    // Complete: straight to the admin queue. A caption edit keeps the
    // seller's words instead of regenerating the caption.
    await submitToAdminReview(deps, convo, updated, {
      status: "SUBMITTED",
      missing: [],
      keepCaption: field === "caption",
    });
  } else {
    // Still incomplete — no follow-up question. The admin sees the missing
    // fields in review and approves or rejects.
    await submitToAdminReview(deps, convo, updated, { status: "NEEDS_REVIEW", missing: after.missing });
  }
}

// Re-exported for the finalize worker + tests.
export type { QuestionSpec, VisionResult };
