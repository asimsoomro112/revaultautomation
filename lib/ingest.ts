/**
 * Ingest worker core (Phase 1).
 *
 * processIngest(payload, deps) is the pure, dependency-injected heart of
 * POST /api/workers/ingest — fully unit-testable with fake db/storage/qstash.
 * The route handler (app/api/workers/ingest/route.ts) only verifies the QStash
 * signature, zod-parses the payload, and wires real dependencies.
 *
 * Behaviour:
 * - image → download bytes NOW to raw/{listingId}/{photoId}.jpg (existing
 *   active DRAFT listing for the sender, else a new one), record the photo,
 *   ensure the conversation is COLLECTING, (re)schedule finalize-photos after
 *   PHOTO_DEBOUNCE_SECONDS carrying photo_at = this photo's timestamp.
 * - text | quick_reply | unsupported → hand to the message worker (Phase 2
 *   owns replies, incl. the polite "send photos as images" reply).
 * - echo | unknown → log and ignore.
 */
import { z } from "zod";
import { log } from "./log";
import { sanitizePhotoId } from "./db";
import type {
  ConversationDoc,
  IngestPayload,
  ListingDoc,
  ListingPhoto,
  NormalizedInbound,
  WorkerKind,
  WorkerPayload,
} from "./types";

// --- WorkerPayload zod schemas ------------------------------------------------

const normalizedInboundSchema = z.object({
  kind: z.enum(["text", "image", "quick_reply", "unsupported", "echo", "unknown"]),
  mid: z.string(),
  sender_igsid: z.string(),
  recipient_igid: z.string(),
  timestamp_ms: z.number(),
  text: z.string().nullable(),
  image_url: z.string().nullable(),
  quick_reply_payload: z.string().nullable(),
  unsupported_hint: z.string().nullable(),
});

const ingestPayloadSchema = z.object({
  kind: z.literal("ingest"),
  message: normalizedInboundSchema,
});

const messagePayloadSchema = z.object({
  kind: z.literal("message"),
  igsid: z.string(),
  mid: z.string(),
});

const finalizePhotosPayloadSchema = z.object({
  kind: z.literal("finalize-photos"),
  listing_id: z.string(),
  photo_at: z.string(),
});

const publishPayloadSchema = z.object({
  kind: z.literal("publish"),
  listing_id: z.string(),
});

const pollContainerPayloadSchema = z.object({
  kind: z.literal("poll-container"),
  listing_id: z.string(),
  container_id: z.string(),
  role: z.enum(["child", "parent"]),
  attempt: z.number().int().nonnegative(),
});

export const WorkerPayloadSchema = z.discriminatedUnion("kind", [
  ingestPayloadSchema,
  messagePayloadSchema,
  finalizePhotosPayloadSchema,
  publishPayloadSchema,
  pollContainerPayloadSchema,
]);

// --- Dependencies (injected for testability) -----------------------------------

export interface EnqueueFn {
  (
    route: WorkerKind,
    payload: WorkerPayload,
    opts?: { delaySec?: number; notBefore?: number; deduplicationId?: string } | undefined,
  ): Promise<void>;
}

export interface IngestDeps {
  downloadImage: (url: string, destPath: string) => Promise<{ bytes: number }>;
  getOrCreateConversation: (igsid: string) => Promise<ConversationDoc>;
  saveConversation: (igsid: string, patch: Partial<ConversationDoc>) => Promise<ConversationDoc>;
  getListing: (id: string) => Promise<ListingDoc | null>;
  createListing: (doc: ListingDoc) => Promise<void>;
  saveListing: (id: string, patch: Partial<ListingDoc>) => Promise<void>;
  blankListingDoc: (id: string, sellerIgsid: string, nowIso: string) => ListingDoc;
  newListingId: () => string;
  enqueue: EnqueueFn;
  getPhotoDebounceSeconds: () => number;
  nowIso?: () => string;
  /**
   * Phase 2: persist the NormalizedInbound so the message worker can load it
   * back by mid (MessagePayload carries only {igsid, mid}). Optional so
   * existing callers/tests keep working; when absent the message worker
   * cannot see the text and will skip gracefully.
   */
  saveInbound?: (inbound: NormalizedInbound) => Promise<void>;
}

export interface IngestResult {
  action: "photo-saved" | "enqueued-message" | "ignored";
  listingId?: string;
}

async function handleImage(message: NormalizedInbound, deps: IngestDeps, now: string): Promise<IngestResult> {
  const igsid = message.sender_igsid;

  if (!message.image_url) {
    // Defensive: parser guarantees image_url for kind 'image', but never crash
    // the worker on a malformed payload — hand it to the message worker.
    log.warn("ingest: image inbound without image_url", { mid: message.mid });
    await deps.enqueue("message", { kind: "message", igsid, mid: message.mid });
    return { action: "enqueued-message" };
  }

  // Reuse the sender's active DRAFT listing; otherwise start a new one.
  const conv = await deps.getOrCreateConversation(igsid);
  let listing: ListingDoc | null = null;
  if (conv.active_listing_id) {
    const existing = await deps.getListing(conv.active_listing_id);
    if (existing && existing.status === "DRAFT") listing = existing;
  }
  if (!listing) {
    const id = deps.newListingId();
    listing = deps.blankListingDoc(id, igsid, now);
    await deps.createListing(listing);
    log.info("ingest: new listing", { listingId: id });
  }
  const listingId = listing.id;

  // Download bytes NOW — Meta CDN URLs expire, so this cannot wait.
  const photoId = sanitizePhotoId(message.mid);
  const destPath = `raw/${listingId}/${photoId}.jpg`;
  const { bytes } = await deps.downloadImage(message.image_url, destPath);

  const photo: ListingPhoto = {
    storage_path: destPath,
    w: 0, // Phase 3 fills real dimensions + phash during processing
    h: 0,
    phash: "",
    received_at: now,
  };
  await deps.saveListing(listingId, {
    photos: [...listing.photos, photo],
    last_photo_at: now,
  });
  await deps.saveConversation(igsid, {
    state: "COLLECTING",
    active_listing_id: listingId,
    last_user_msg_at: now,
    window_open: true,
  });

  // (Re)arm the photo debounce timer. finalize-photos skips itself when
  // last_photo_at has moved on (a newer photo re-armed the timer).
  await deps.enqueue(
    "finalize-photos",
    { kind: "finalize-photos", listing_id: listingId, photo_at: now },
    {
      delaySec: deps.getPhotoDebounceSeconds(),
      deduplicationId: `finalize-${listingId}-${now}`,
    },
  );

  log.info("ingest: photo saved", { listingId, bytes });
  return { action: "photo-saved", listingId };
}

/**
 * Process one normalized inbound message. Pure apart from injected deps —
 * no direct imports of db/storage/qstash here.
 */
export async function processIngest(payload: IngestPayload, deps: IngestDeps): Promise<IngestResult> {
  const message = payload.message;
  const now = deps.nowIso ? deps.nowIso() : new Date().toISOString();

  switch (message.kind) {
    case "image":
      return handleImage(message, deps, now);
    case "text":
    case "quick_reply":
    case "unsupported":
      // Phase 2's message worker owns all replies (greetings, polite
      // "send photos as images" for stickers/video, intent routing).
      // Persist the inbound first — the message worker loads it by mid.
      if (deps.saveInbound) await deps.saveInbound(message);
      await deps.enqueue("message", {
        kind: "message",
        igsid: message.sender_igsid,
        mid: message.mid,
      });
      return { action: "enqueued-message" };
    case "echo":
    case "unknown":
      log.info("ingest: ignoring inbound", { kind: message.kind, mid: message.mid });
      return { action: "ignored" };
  }
}
