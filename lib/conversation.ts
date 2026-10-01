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
  clarifyRetry,
  collectingAck,
  confirmNudge,
  confirmPreviewText,
  consentQuickReplies,
  consentText,
  helpText,
  humanHandoffReply,
  listingLimitReply,
  questionForField,
  type QuestionSpec,
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

const HUMAN_RE = /\bhuman\b|insan|banda|admi|real\s*person|asli\s+(banda|insan)|operator\s*(se)?\s*baat/i;

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
// Deps port — db shape mirrors lib/db.ts (Phase 1); fakes in tests
// ---------------------------------------------------------------------------

export interface DbPort {
  getOrCreateConversation(igsid: string): Promise<ConversationDoc>;
  saveConversation(igsid: string, patch: Partial<ConversationDoc>): Promise<ConversationDoc>;
  getListing(id: string): Promise<ListingDoc | null>;
  saveListing(id: string, patch: Partial<ListingDoc>): Promise<void>;
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
}

/** Persist the mutated conversation doc (db API is patch-based). */
async function persistConvo(deps: Deps, convo: ConversationDoc): Promise<void> {
  await deps.db.saveConversation(convo.igsid, { ...convo });
}

/** Persist the mutated listing doc (db API is patch-based). */
async function persistListing(deps: Deps, listing: ListingDoc): Promise<void> {
  await deps.db.saveListing(listing.id, { ...listing });
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
}

// ---------------------------------------------------------------------------
// Send helper: never send outside the 24h window
// ---------------------------------------------------------------------------

export async function sendSafe(
  deps: Deps,
  convo: ConversationDoc,
  opts: SendMessageOpts,
): Promise<{ sent: boolean; messageId?: string }> {
  if (!isWithinWindow(convo.last_user_msg_at)) {
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
    } else {
      log.error("message.send_failed", { igsid: convo.igsid, error: err instanceof Error ? err.message : String(err) });
    }
    return { sent: false };
  }
}

// ---------------------------------------------------------------------------
// Shared: move a complete listing to CONFIRM (message worker + finalize worker)
// ---------------------------------------------------------------------------

export async function moveToConfirm(deps: Deps, convo: ConversationDoc, listing: ListingDoc): Promise<void> {
  if (!listing.extracted) throw new Error("moveToConfirm: listing has no extracted data");
  const caption = await deps.buildCaption(listing.extracted, convo.lang);
  listing.caption = caption;
  listing.status = "CONFIRM";
  await persistListing(deps, listing);
  await deps.db.appendListingEvent(listing.id, { type: "confirm", caption_chars: caption.length });
  setConversationState(convo, "CONFIRM");
  await persistConvo(deps, convo);
  const preview = confirmPreviewText(listing.extracted, caption, convo.lang);
  await sendSafe(deps, convo, {
    text: `${preview}\n\n${consentText(convo.lang)}`,
    quickReplies: consentQuickReplies(),
  });
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
 * Ensure the conversation has an active DRAFT-ish listing. Shared with the
 * ingest worker (Phase 1): call this when photos arrive with no active listing.
 * Returns { listing: null } when the seller hit the daily listing limit.
 */
export async function ensureActiveListing(
  deps: Deps,
  convo: ConversationDoc,
  nowIso: string,
): Promise<{ listing: ListingDoc | null; isNew: boolean }> {
  if (convo.active_listing_id) {
    const existing = await activeListing(deps, convo);
    if (existing && (existing.status === "DRAFT" || existing.status === "NEEDS_INFO" || existing.status === "CONFIRM")) {
      if (convo.state === "IDLE") setConversationState(convo, "COLLECTING");
      return { listing: existing, isNew: false };
    }
    convo.active_listing_id = null; // stale pointer (submitted/rejected/…)
  }
  if (convo.listings_today >= deps.maxListingsPerSellerPerDay) return { listing: null, isNew: false };
  const listing = deps.db.blankListingDoc(deps.db.newListingId(), convo.igsid, nowIso);
  await deps.db.createListing(listing);
  convo.active_listing_id = listing.id;
  convo.intent = "SELLER_SUBMIT";
  convo.listings_today += 1;
  if (convo.state === "IDLE") setConversationState(convo, "COLLECTING");
  await deps.db.appendListingEvent(listing.id, { type: "created", source: "dm" });
  return { listing, isNew: true };
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

  // --- inbound anchors (saved immediately so retries stay idempotent) ---
  convo.last_user_msg_at = nowIso;
  convo.window_open = true;
  convo.user_msg_total += 1;
  convo.last_processed_mid = mid;
  const text = inbound.text?.trim() ?? "";
  if (convo.user_msg_total <= 2 && text) convo.lang = detectLang([text]);
  await persistConvo(deps, convo);

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
    await sendSafe(deps, convo, { text: unsupportedReply(inbound.unsupported_hint ?? "", convo.lang) });
  } else {
    log.info("message.unhandled_kind", { kind: inbound.kind, mid });
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
          ensured.listing.chat_text = appendChat(ensured.listing.chat_text, text);
          await persistListing(deps, ensured.listing);
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
      listing.chat_text = appendChat(listing.chat_text, text);
      await persistListing(deps, listing);
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
      // Typed answer to the pending question. Quick-reply taps arrive as
      // quick_reply kind; typed text may match a numbered/word fallback.
      const pending = nextQuestion(readyForConfirm(listing).missing, convo.lang, listing.photos.length);
      const matched = pending.quickReplies ? matchTypedAnswer(text, pending.quickReplies) : null;
      await handleInfoAnswer(deps, convo, listing, pending.field, matched ?? text);
      break;
    }
    case "CONFIRM": {
      await persistConvo(deps, convo);
      await sendSafe(deps, convo, { text: confirmNudge(convo.lang), quickReplies: consentQuickReplies() });
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
    listing.consent = { at: nowIso, message_id: mid };
    listing.status = "SUBMITTED";
    await persistListing(deps, listing);
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
    listing.status = "REJECTED";
    await persistListing(deps, listing);
    await deps.db.appendListingEvent(listing.id, { type: "cancelled_by_seller" });
  }
  setConversationState(convo, "IDLE");
  convo.active_listing_id = null;
  await persistConvo(deps, convo);
  await sendSafe(deps, convo, { text: cancelReply(convo.lang) });
}

async function handleConsentEdit(deps: Deps, convo: ConversationDoc): Promise<void> {
  const listing = await activeListing(deps, convo);
  if (!listing || convo.state !== "CONFIRM") {
    await persistConvo(deps, convo);
    return;
  }
  listing.status = "NEEDS_INFO";
  listing.missing = ["caption"];
  await persistListing(deps, listing);
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
    // Photos can't be answered by text — re-ask.
    const q = nextQuestion(["photos"], convo.lang, listing.photos.length);
    await persistConvo(deps, convo);
    await sendSafe(deps, convo, { text: q.question });
    return;
  }
  const coerced = coerceFieldValue(field, rawValue);
  const check = readyForConfirm(listing);
  if (!coerced.ok) {
    const q = nextQuestion(check.missing, convo.lang, listing.photos.length);
    await persistConvo(deps, convo);
    await sendSafe(deps, convo, sendOpts(clarifyRetry(convo.lang, q.question), q.quickReplies));
    return;
  }
  applyFieldValue(listing, field, coerced.value);
  listing.missing = listing.missing.filter((m) => m !== field);
  listing.chat_text = appendChat(listing.chat_text, `[${field}] ${rawValue.trim()}`);
  const after = readyForConfirm(listing);
  if (after.ok) {
    await moveToConfirm(deps, convo, listing);
  } else {
    listing.status = "NEEDS_INFO";
    await persistListing(deps, listing);
    setConversationState(convo, "NEEDS_INFO");
    await persistConvo(deps, convo);
    const q = nextQuestion(after.missing, convo.lang, listing.photos.length);
    await sendSafe(deps, convo, sendOpts(q.question, q.quickReplies));
  }
}

/** Build SendMessageOpts without passing explicit `undefined` quickReplies (exactOptionalPropertyTypes). */
function sendOpts(text: string, quickReplies: QuickReply[] | undefined): SendMessageOpts {
  return quickReplies ? { text, quickReplies } : { text };
}

// Re-exported for the finalize worker + tests.
export type { QuestionSpec, VisionResult };
