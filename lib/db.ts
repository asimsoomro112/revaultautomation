/**
 * Firestore access layer (Phase 1) — lazy firebase-admin singleton.
 *
 * The Admin SDK is initialised on first use (never at import time) so unit
 * tests and `next build` work without credentials. Callers that touch
 * Firestore must ensure env is present (requireFirebaseEnv throws a
 * clear error otherwise). All data access in later phases goes through this
 * module — never construct Firestore references ad-hoc.
 *
 * Photo storage lives in Cloudinary (lib/storage.ts) — this module is
 * Firestore-only since the 2026-10-01 storage swap.
 *
 * Collections (per plan §4): admin_settings/global, conversations/{igsid},
 * listings/{listingId}, listings/{id}/events/{autoId}, processed_webhooks/{mid}
 * (TTL 7d on expire_at — configure the TTL policy in the Firebase console),
 * phash_index/{dhash}, blocklist/{igsid}, counters/...
 */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomBytes } from "node:crypto";
import { getEnv, requireFirebaseEnv, type Env } from "./env";
import type { AdminSettings, ConversationDoc, DeepPartial, ListingDoc, NormalizedInbound } from "./types";

let app: App | null = null;

function getApp(): App {
  if (app) return app;
  const env = requireFirebaseEnv();
  const existing = getApps();
  if (existing.length > 0 && existing[0]) {
    app = existing[0];
    return app;
  }
  const projectId = env.FIREBASE_PROJECT_ID as string;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL as string;
  // Service-account private keys are stored with literal \n escapes in env.
  const privateKey = (env.FIREBASE_PRIVATE_KEY as string).replace(/\\n/g, "\n");
  app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return app;
}

/** Canonical Admin SDK app — the single init point for the whole codebase.
 * (Sets storageBucket, which the Storage helpers require.) */
export function getFirebaseApp(): App {
  return getApp();
}

/** Firestore instance. Throws (clear error) when Firebase env is missing. */
export function db(): Firestore {
  return getFirestore(getApp());
}

/** Top-level collection reference. */
export function col(name: string) {
  return db().collection(name);
}

/** New listing id (also the idempotency key for the whole pipeline). */
export function newListingId(): string {
  return `lst_${randomBytes(6).toString("hex")}`;
}

/** Sanitize a Meta mid into a safe Storage filename segment. */
export function sanitizePhotoId(mid: string): string {
  return mid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** yyyy-MM-dd in Asia/Karachi (no DST in PKT). */
export function pktDay(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// --- Webhook dedupe ----------------------------------------------------------

/**
 * Claim a webhook message id. Returns true when this caller is the first to
 * claim `mid` (proceed), false when it was already processed (skip).
 * Implemented as a Firestore transaction so concurrent deliveries are safe.
 */
export async function claimWebhookMid(mid: string): Promise<boolean> {
  const ref = col("processed_webhooks").doc(mid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      at: FieldValue.serverTimestamp(),
      // 7-day TTL — needs a Firestore TTL policy on `expire_at` (see SETUP.md).
      expire_at: Timestamp.fromMillis(Date.now() + 7 * 24 * 3600 * 1000),
    });
    return true;
  });
}

// --- Conversations -----------------------------------------------------------

function blankConversation(igsid: string): ConversationDoc {
  return {
    igsid,
    state: "IDLE",
    lang: "roman",
    active_listing_id: null,
    intent: null,
    listings_today: 0,
    listings_day: pktDay(),
    last_user_msg_at: null,
    window_open: false,
    human_needed: false,
    blocked: false,
    msg_count_1h: 0,
    msg_window_start: null,
    user_msg_total: 0,
    last_processed_mid: null,
  };
}

export async function getOrCreateConversation(igsid: string): Promise<ConversationDoc> {
  const ref = col("conversations").doc(igsid);
  const snap = await ref.get();
  if (snap.exists) return snap.data() as ConversationDoc;
  const doc = blankConversation(igsid);
  await ref.set(doc);
  return doc;
}

export async function saveConversation(igsid: string, patch: Partial<ConversationDoc>): Promise<ConversationDoc> {
  const ref = col("conversations").doc(igsid);
  await ref.set({ ...patch, igsid }, { merge: true });
  const snap = await ref.get();
  return snap.data() as ConversationDoc;
}

// --- Listings ----------------------------------------------------------------

/** Fresh DRAFT listing document. Pure — safe to use in tests without Firebase. */
export function blankListingDoc(id: string, sellerIgsid: string, nowIso: string): ListingDoc {
  return {
    id,
    seller_igsid: sellerIgsid,
    created_at: nowIso,
    status: "DRAFT",
    photos: [],
    last_photo_at: null,
    extracted: null,
    missing: [],
    moderation: null,
    caption: null,
    consent: null,
    chat_text: "",
    publish: {
      slot_at: null,
      container_ids: [],
      parent_container_id: null,
      container_status: {},
      locked_until: null,
      media_id: null,
      permalink: null,
      attempts: 0,
      last_error: null,
    },
    review: { note: null, decided_by: null, decided_at: null },
  };
}

export async function getListing(id: string): Promise<ListingDoc | null> {
  const snap = await col("listings").doc(id).get();
  return snap.exists ? (snap.data() as ListingDoc) : null;
}

export async function createListing(doc: ListingDoc): Promise<void> {
  await col("listings").doc(doc.id).set(doc);
}

export async function saveListing(id: string, patch: DeepPartial<ListingDoc>): Promise<void> {
  await col("listings").doc(id).set(patch, { merge: true });
}

/** Append to a listing's audit trail (listings/{id}/events/{autoId}). */
export async function appendListingEvent(
  listingId: string,
  event: { type: string; at?: string; [k: string]: unknown },
): Promise<void> {
  await col("listings")
    .doc(listingId)
    .collection("events")
    .add({ at: new Date().toISOString(), ...event });
}

// --- Inbound message handoff (Phase 2) ----------------------------------------
// The ingest worker persists the NormalizedInbound here before enqueueing the
// message worker, because MessagePayload carries only {igsid, mid}. The
// message worker loads it back via getInboundMessage. TTL 7d on expire_at
// (same Firestore TTL policy pattern as processed_webhooks).

/** Persist a normalized inbound message for the message worker to consume. */
export async function saveInboundMessage(inbound: NormalizedInbound): Promise<void> {
  await col("inbound_messages")
    .doc(inbound.mid)
    .set({ ...inbound, expire_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() });
}

/** Load a persisted inbound message by mid (null when absent/expired). */
export async function getInboundMessage(mid: string): Promise<NormalizedInbound | null> {
  const snap = await col("inbound_messages").doc(mid).get();
  if (!snap.exists) return null;
  return snap.data() as NormalizedInbound;
}

// --- Admin settings ----------------------------------------------------------

export function defaultAdminSettings(env: Env): AdminSettings {
  return {
    global_kill_switch: false,
    publish_mode: env.PUBLISH_MODE,
    max_posts_per_day: env.MAX_POSTS_PER_DAY,
    min_gap_minutes: env.MIN_GAP_MINUTES,
    posting_window: { start: env.POSTING_WINDOW_START, end: env.POSTING_WINDOW_END, tz: env.TZ },
    max_listings_per_seller_per_day: env.MAX_LISTINGS_PER_SELLER_PER_DAY,
    photo_debounce_seconds: env.PHOTO_DEBOUNCE_SECONDS,
    retention_days: env.RETENTION_DAYS,
    caption_cta: env.CAPTION_CTA,
    cover_slide_enabled: env.COVER_SLIDE_ENABLED,
    faq_buyer: "",
    ig_user_id: env.IG_USER_ID ?? "",
    token: null,
    token_health: "missing",
  };
}

/** Global admin_settings doc; created with env-backed defaults when missing. */
export async function getAdminSettings(): Promise<AdminSettings> {
  const ref = col("admin_settings").doc("global");
  const snap = await ref.get();
  if (snap.exists) return snap.data() as AdminSettings;
  const defaults = defaultAdminSettings(getEnv());
  await ref.set(defaults);
  return defaults;
}

/** Merge-update admin_settings/global (creates the doc on first use). */
export async function updateAdminSettings(patch: Record<string, unknown>): Promise<void> {
  await col("admin_settings").doc("global").set(patch, { merge: true });
}

// --- Blocklist / duplicates --------------------------------------------------

/** True when the seller is on the blocklist (blocklist/{igsid} exists). */
export async function isBlocklisted(igsid: string): Promise<boolean> {
  const snap = await col("blocklist").doc(igsid).get();
  return snap.exists;
}

/** Alias kept for the moderation pipeline's naming. */
export async function isSellerBlocklisted(igsid: string): Promise<boolean> {
  return isBlocklisted(igsid);
}

export interface DupEntry {
  /** 16-hex-char dHash of a previously seen listing photo. */
  phash: string;
  listing_id: string;
  /** ISO timestamp the photo was recorded. */
  at: string;
}

/**
 * Exact dHash lookup. Returns the owning listing id or null.
 * Fuzzy (Hamming-distance) matching is the caller's job (Phase 3).
 */
export async function findDuplicatePhash(phash: string): Promise<string | null> {
  const entry = await findDuplicatePhashEntry(phash);
  return entry ? entry.listing_id : null;
}

/** Same lookup but returning the full entry (for the moderation pipeline). */
export async function findDuplicatePhashEntry(phash: string): Promise<DupEntry | null> {
  const snap = await col("phash_index").doc(phash).get();
  if (!snap.exists) return null;
  const data = snap.data() as { listing_id?: string; at?: string } | undefined;
  return {
    phash,
    listing_id: data?.listing_id ?? "",
    at: data?.at ?? "",
  };
}

/**
 * Recent index entries for Hamming-distance (near-duplicate) comparison.
 * Bounded: callers iterate this in-memory, so keep the window small.
 */
export async function findRecentPhashes(sinceDays = 90, limit = 500): Promise<DupEntry[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const snap = await col("phash_index").where("at", ">=", since).limit(limit).get();
  return snap.docs.map((d) => {
    const data = d.data() as { listing_id?: string; at?: string } | undefined;
    return {
      phash: d.id,
      listing_id: data?.listing_id ?? "",
      at: data?.at ?? "",
    };
  });
}

/**
 * Record a photo hash after a listing passes the intake pipeline.
 * Called by the finalize worker (Phase 2/4), NOT by the moderation read path.
 * Idempotent: doc id IS the hash, so re-recording is a no-op overwrite.
 */
export async function recordPhash(phash: string, listingId: string): Promise<void> {
  await col("phash_index").doc(phash).set(
    {
      listing_id: listingId,
      at: new Date().toISOString(),
    },
    { merge: true },
  );
}

// --- Publish pacing counters (Phase 4 — plan §4) ------------------------------

/** Posts published on a PKT day (counters/daily_posts/{yyyy-MM-dd}). */
export async function getDailyPostCount(pktDayStr: string): Promise<number> {
  const snap = await col("counters").doc(`daily_posts_${pktDayStr}`).get();
  const n = snap.exists ? (snap.data()?.count as number | undefined) : undefined;
  return typeof n === "number" ? n : 0;
}

/** Atomically increment the daily post counter; returns the new count. */
export async function incrementDailyPostCount(pktDayStr: string): Promise<number> {
  const ref = col("counters").doc(`daily_posts_${pktDayStr}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? ((snap.data()?.count as number | undefined) ?? 0) : 0;
    const next = cur + 1;
    tx.set(ref, { count: next }, { merge: true });
    return next;
  });
}

/** Instant of the last successful publish (drives the min-gap rule). */
export async function getLastPublishAt(): Promise<Date | null> {
  const snap = await col("counters").doc("publish_meta").get();
  const iso = snap.exists ? (snap.data()?.last_publish_at as string | undefined) : undefined;
  return iso ? new Date(iso) : null;
}

export async function setLastPublishAt(d: Date): Promise<void> {
  await col("counters").doc("publish_meta").set({ last_publish_at: d.toISOString() }, { merge: true });
}
