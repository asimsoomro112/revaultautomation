/**
 * Shared in-memory fakes for Phase 2 unit tests (conversation + finalize).
 * Not a test file itself — vitest only collects *.test.ts.
 */
import { blankListingDoc } from "./db";
import type { Deps } from "./conversation";
import type { FinalizeDeps } from "./finalize";
import type { GeminiClient, IntentResult, VisionResult } from "./gemini";
import { MetaApiError, type MetaClient, type SendMessageOpts } from "./meta";
import type { AlertOpts } from "./telegram";
import type {
  AdminSettings,
  ConversationDoc,
  ExtractedItem,
  Lang,
  ListingDoc,
  ListingPhoto,
  NormalizedInbound,
  WorkerKind,
  WorkerPayload,
} from "./types";

/** A minimal valid ListingPhoto for tests. */
export function makePhoto(storagePath: string, at: string = NOW): ListingPhoto {
  return { storage_path: storagePath, w: 800, h: 1000, phash: "a".repeat(16), received_at: at };
}

export const NOW = "2026-09-30T17:05:00.000Z";
export const IGSID = "98765432109876543";
export const IGID = "17841400008460056";

export function blankTestConversation(igsid: string = IGSID): ConversationDoc {
  return {
    igsid,
    state: "IDLE",
    lang: "roman",
    active_listing_id: null,
    intent: null,
    listings_today: 0,
    listings_day: "2026-09-30",
    last_user_msg_at: null,
    window_open: true,
    human_needed: false,
    blocked: false,
    msg_count_1h: 0,
    msg_window_start: null,
    user_msg_total: 0,
    last_processed_mid: null,
  };
}

export function makeInbound(  kind: NormalizedInbound["kind"],
  mid: string,
  extra: Partial<NormalizedInbound> = {},
): NormalizedInbound {
  return {
    kind,
    mid,
    sender_igsid: IGSID,
    recipient_igid: IGID,
    timestamp_ms: 1790812854123,
    text: null,
    image_url: null,
    quick_reply_payload: null,
    unsupported_hint: null,
    ...extra,
  };
}

export interface SentMsg {
  igsid: string;
  opts: SendMessageOpts;
}

export interface Enqueued {
  route: WorkerKind;
  payload: WorkerPayload;
  opts?: { delaySec?: number; notBefore?: number; deduplicationId?: string } | undefined;
}

export interface AdminAlert {
  text: string;
  opts?: AlertOpts;
}

export function blankTestExtracted(): ExtractedItem {
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

/** A fully-extracted item (passes readyForConfirm when photos ≥ 2). */
export function fullTestExtracted(): ExtractedItem {
  const e = blankTestExtracted();
  e.title = "Zara blazer";
  e.category = "blazer";
  e.gender = "women";
  e.size = "M";
  e.condition = "like_new";
  e.price_pkr = 2500;
  e.city = "Karachi";
  e.confidence = { category: 0.9, size: 0.9, condition: 0.9, price_pkr: 0.9, city: 0.9 };
  return e;
}

export function makeVisionResult(overrides: Partial<VisionResult> = {}): VisionResult {
  return {
    extracted: fullTestExtracted(),
    missing: [],
    moderation: {
      verdict: "PASS",
      reasons: [],
      counterfeit_claim: false,
      text_contact_info: false,
      per_image: [],
    },
    ...overrides,
  };
}

export interface FakeGemini extends GeminiClient {
  classifyIntentImpl: (text: string, history: string[]) => Promise<IntentResult>;
  extractListingImpl: (bufs: Buffer[], chat: string, lang: Lang) => Promise<VisionResult>;
}

export function makeFakeGemini(): FakeGemini {
  const fake: FakeGemini = {
    classifyIntentImpl: async () => ({ intent: "OTHER", confidence: 0.1, lang: "roman" }),
    extractListingImpl: async () => {
      throw new Error("extractListing not stubbed");
    },
    classifyIntent: (t, h) => fake.classifyIntentImpl(t, h),
    extractListing: (b, c, l) => fake.extractListingImpl(b, c, l),
    writeCaption: async () => "caption",
    chatReply: async (p) => `reply: ${p}`,
  };
  return fake;
}

export interface FakeMeta extends MetaClient {
  sent: SentMsg[];
  /** When set, sendMessage throws this instead of succeeding. */
  sendFailsWith: unknown;
}

export function makeFakeMeta(): FakeMeta {
  const fake: FakeMeta = {
    sent: [],
    sendFailsWith: undefined,
    sendMessage: async (igsid: string, opts: SendMessageOpts) => {
      if (fake.sendFailsWith !== undefined) throw fake.sendFailsWith;
      fake.sent.push({ igsid, opts });
      return { messageId: `mid_out_${fake.sent.length}` };
    },
    createImageContainer: async () => "container_1",
    createCarouselContainer: async () => "carousel_1",
    getContainerStatus: async () => "FINISHED",
    publishContainer: async () => "media_1",
    getPermalink: async () => "https://instagram.com/p/x",
    getPublishingLimit: async () => ({ quota_usage: 0, quota_total: 100 }),
  };
  return fake;
}

/** MetaApiError shaped like a 24h-window violation (error code 10 / subcode 2534022 pattern). */
export function makeWindowError(): MetaApiError {
  const err = new MetaApiError("This message is sent outside the allowed window", 10, 2534022, 400);
  return err;
}

export interface FakeDb {
  convos: Map<string, ConversationDoc>;
  listings: Map<string, ListingDoc>;
  events: Array<{ listingId: string; event: { type: string; at?: string; [k: string]: unknown } }>;
  /** Duplicate-index writes (recordPhash calls) for assertions. */
  phashes: Array<{ phash: string; listingId: string }>;
  settings: AdminSettings;
  failOnSave: boolean;
}

export function makeFakeDb(settings?: Partial<AdminSettings>): FakeDb {
  return {
    convos: new Map(),
    listings: new Map(),
    events: [],
    phashes: [],
    settings: {
      global_kill_switch: false,
      publish_mode: "review",
      max_posts_per_day: 3,
      min_gap_minutes: 60,
      posting_window: { start: "09:00", end: "22:00", tz: "Asia/Karachi" },
      max_listings_per_seller_per_day: 5,
      photo_debounce_seconds: 90,
      retention_days: 30,
      caption_cta: "dm",
      cover_slide_enabled: false,
      faq_buyer: "FAQ: DM to buy",
      ig_user_id: "17841400008460056",
      token: null,
      token_health: "missing",
      ...settings,
    },
    failOnSave: false,
  };
}

export interface FakeDeps extends Deps {
  gemini: FakeGemini;
  meta: FakeMeta;
  fdb: FakeDb;
  alerts: AdminAlert[];
  enqueued: Enqueued[];
  nowValue: string;
  downloads: Map<string, Buffer>;
}

export function makeFakeDeps(overrides: Partial<FakeDb> = {}): FakeDeps {
  const fdb = makeFakeDb();
  Object.assign(fdb, overrides);
  const gemini = makeFakeGemini();
  const meta = makeFakeMeta();
  const alerts: AdminAlert[] = [];
  const enqueued: Enqueued[] = [];
  const downloads = new Map<string, Buffer>();
  let idSeq = 0;

  const deps: FakeDeps = {
    fdb,
    gemini,
    meta,
    alerts,
    enqueued,
    nowValue: NOW,
    downloads,
    db: {
      getOrCreateConversation: async (igsid: string) => {
        let c = fdb.convos.get(igsid);
        if (!c) {
          c = blankTestConversation(igsid);
          fdb.convos.set(igsid, c);
        }
        return c;
      },
      saveConversation: async (igsid: string, patch: Partial<ConversationDoc>) => {
        const c = fdb.convos.get(igsid) ?? blankTestConversation(igsid);
        Object.assign(c, patch);
        fdb.convos.set(igsid, c);
        return c;
      },
      getListing: async (id: string) => fdb.listings.get(id) ?? null,
      saveListing: async (id: string, patch: Partial<ListingDoc>) => {
        if (fdb.failOnSave) throw new Error("fake db save failed");
        const l = fdb.listings.get(id);
        if (l) Object.assign(l, patch);
        else fdb.listings.set(id, patch as ListingDoc);
      },
      createListing: async (doc: ListingDoc) => {
        fdb.listings.set(doc.id, doc);
      },
      appendListingEvent: async (listingId: string, event: { type: string; at?: string; [k: string]: unknown }) => {
        fdb.events.push({ listingId, event });
      },
      getAdminSettings: async () => fdb.settings,
      recordPhash: async (phash: string, listingId: string) => {
        fdb.phashes.push({ phash, listingId });
      },
      newListingId: () => `lst_test_${++idSeq}`,
      blankListingDoc: (id: string, sellerIgsid: string, nowIso: string) =>
        blankListingDoc(id, sellerIgsid, nowIso),
    },
    notifyAdmin: async (text: string, opts?: AlertOpts) => {
      if (opts === undefined) alerts.push({ text });
      else alerts.push({ text, opts });
    },
    enqueueWorker: async (route: WorkerKind, payload: WorkerPayload, opts?) => {
      enqueued.push({ route, payload, opts });
    },
    buildCaption: async () => "test caption #revault",
    now: () => deps.nowValue,
    maxListingsPerSellerPerDay: 5,
  };
  return deps;
}

export function makeFinalizeDeps(base: FakeDeps): FinalizeDeps {
  return {
    ...base,
    downloadBytes: async (storagePath: string) => {
      const b = base.downloads.get(storagePath);
      if (!b) throw new Error(`no fake bytes for ${storagePath}`);
      return b;
    },
  };
}

export { MetaApiError };
