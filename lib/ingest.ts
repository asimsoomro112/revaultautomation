/**
 * Ingest worker core (Phase 1).
 *
 * processIngest(payload, deps) is the pure, dependency-injected heart of
 * POST /api/workers/ingest — fully unit-testable with fake db/storage/qstash.
 * The route handler (app/api/workers/ingest/route.ts) only verifies the QStash
 * signature, zod-parses the payload, and wires real dependencies.
 *
 * Behaviour:
 * - image → download bytes NOW to raw/{listingId}/{photoId}.jpg (the sender's
 *   active DRAFT/NEEDS_INFO listing via transactional getOrCreateActiveListing,
 *   else a new one), append the photo transactionally, ensure the
 *   conversation is COLLECTING, (re)schedule finalize-photos after
 *   PHOTO_DEBOUNCE_SECONDS carrying photo_at = this photo's timestamp and
 *   activity_at = the same instant (burst-combine: any later photo or text
 *   re-arms the timer with a fresh activity_at, so extraction waits for the
 *   whole burst — all photos + the details text — to settle).
 *   A failed CDN download re-enqueues the ingest itself (bounded, 30s
 *   apart) instead of dropping the photo on a transient failure.
 * - text | quick_reply | unsupported → hand to the message worker (Phase 2
 *   owns replies, incl. the polite "send photos as images" reply).
 * - echo | unknown → log and ignore.
 */
import { z } from "zod";
import { log } from "./log";
import { photoStoragePath } from "./db";
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
  attempt: z.number().int().nonnegative().optional(),
});

const messagePayloadSchema = z.object({
  kind: z.literal("message"),
  igsid: z.string(),
  mid: z.string(),
  limit_reply: z.boolean().optional(),
});

const finalizePhotosPayloadSchema = z.object({
  kind: z.literal("finalize-photos"),
  listing_id: z.string(),
  photo_at: z.string(),
  activity_at: z.string().optional(),
  rearm: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
  inflight_waits: z.number().int().nonnegative().optional(),
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
  saveConversation: (igsid: string, patch: Partial<ConversationDoc>) => Promise<ConversationDoc>;
  /**
   * Transactional read-modify-write for a listing (see lib/db.ts
   * mutateListing). Photo appends MUST use this — a getListing +
   * saveListing pair loses photos when burst photos ingest concurrently.
   */
  mutateListing: <T>(
    id: string,
    mutate: (doc: ListingDoc) => { patch: Partial<ListingDoc>; result: T },
  ) => Promise<T>;
  /**
   * Transactional find-or-create of the sender's active DRAFT/NEEDS_INFO
   * listing (see lib/db.ts getOrCreateActiveListing). Concurrent first
   * photos must not each create their own listing.
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
  enqueue: EnqueueFn;
  getPhotoDebounceSeconds: () => number;
  /** Daily listing cap (env MAX_LISTINGS_PER_SELLER_PER_DAY, same source as the message worker). */
  getMaxListingsPerSellerPerDay: () => number;
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
  action: "photo-saved" | "photo-retry" | "enqueued-message" | "ignored" | "limit-reached";
  listingId?: string;
}

/** Bounded self-retries of a failed CDN download before giving up (see handleImage). */
const INGEST_MAX_DOWNLOAD_RETRIES = 2;
const INGEST_DOWNLOAD_RETRY_DELAY_SEC = 30;

async function handleImage(
  message: NormalizedInbound,
  deps: IngestDeps,
  now: string,
  attempt: number,
): Promise<IngestResult> {
  const igsid = message.sender_igsid;

  if (!message.image_url) {
    // Defensive: parser guarantees image_url for kind 'image', but never crash
    // the worker on a malformed payload — hand it to the message worker.
    log.warn("ingest: image inbound without image_url", { mid: message.mid });
    await deps.enqueue("message", { kind: "message", igsid, mid: message.mid });
    return { action: "enqueued-message" };
  }

  // Reuse the sender's active DRAFT *or NEEDS_INFO* listing; otherwise start
  // a new one — atomically (see getOrCreateActiveListing). NEEDS_INFO matters:
  // when the bot asked for a missing photo, the seller's next photo must land
  // on the SAME listing, not spawn a second one. The daily limit is enforced
  // inside that transaction: a photo-first seller over the limit gets NO new
  // listing (null + limitReached) — the photo is dropped, never downloaded,
  // and the message worker sends the polite limit reply so the seller hears
  // why. Reusing an existing active listing never consumes a slot.
  const { listing, closedListing } = await deps.getOrCreateActiveListing(igsid, now, deps.getMaxListingsPerSellerPerDay());
  if (closedListing) {
    // Item boundary: the previous item is complete (photos + details) —
    // finalize it into the admin queue as its own listing.
    await deps.enqueue(
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
  if (!listing) {
    log.info("ingest: daily listing limit reached — photo dropped, limit reply enqueued", { mid: message.mid });
    // Persist the inbound first: the message route skips payloads whose
    // inbound is missing, so without this the limit reply would never send.
    if (deps.saveInbound) await deps.saveInbound(message);
    await deps.enqueue("message", { kind: "message", igsid, mid: message.mid, limit_reply: true });
    return { action: "limit-reached" };
  }
  const listingId = listing.id;

  // Download bytes NOW — Meta CDN URLs expire, so this cannot wait. The
  // download happens OUTSIDE the transaction (no network I/O inside it);
  // the append below is the transactional part.
  // Per-attachment path: one message's N attachments share one mid, so a
  // bare-mid path would collide and photos 2+ would be skipped as
  // "duplicate photo delivery" (see photoStoragePath, lib/db.ts).
  const destPath = photoStoragePath(listingId, message.mid, message.image_url);

  // Idempotent append: a QStash retry re-running this ingest (same mid →
  // same storage_path) must not append the same photo twice — on 2026-11-23
  // the pre-fix ingest 500s made QStash retry whole ingests and listings
  // 1–2 ended up with the same photo twice. The photo is already saved and
  // finalize is already armed, so just touch last_photo_at and re-arm below.
  // Skipping the download also avoids failing on a Meta CDN URL that has
  // expired since the first delivery.
  // The check + append run INSIDE mutateListing: burst photos ingest
  // concurrently, and a getListing + saveListing pair loses photos — two jobs
  // read the same array, each appends its own photo, last writer wins
  // (2026-11-23: Nina sent 3 photos, only 1 survived in lst_a5fa2b817b16).
  let downloadedBytes = 0;
  const alreadySaved = await deps.mutateListing(listingId, (doc) => {
    if (doc.photos.some((p) => p.storage_path === destPath)) {
      return { patch: { last_photo_at: now, last_activity_at: now }, result: true };
    }
    // Burst fix (2026-11-24): claim an in-flight download BEFORE the slow
    // Meta CDN fetch + Cloudinary upload, so a finalize firing 25s after
    // this ingest starts can see the download is still running instead of
    // reading 1 photo with "fresh" timestamps and closing the burst.
    return {
      patch: {
        last_photo_at: now,
        last_activity_at: now,
        inflight_photos: (doc.inflight_photos ?? 0) + 1,
      },
      result: false,
    };
  });
  // Best-effort release of this attempt's inflight claim. A stuck counter
  // would make every later finalize wait out its cap, so a failed release
  // must never mask the download error or the retry.
  const releaseInflight = async () => {
    try {
      await deps.mutateListing(listingId, (doc) => ({
        patch: { inflight_photos: Math.max(0, (doc.inflight_photos ?? 1) - 1) },
        result: undefined,
      }));
    } catch (releaseErr) {
      log.warn("ingest: inflight release failed", {
        listingId,
        mid: message.mid,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  };
  if (!alreadySaved) {
    // A transient download failure (cold function, CDN blip) must not
    // silently lose a burst photo: re-enqueue this same ingest, bounded,
    // instead of failing the worker (QStash retries the 500 too, but its
    // schedule is out of our control — this retry lands 30s later on a
    // warm function). The append below is idempotent on storage_path, so
    // a double delivery can never duplicate the photo.
    let downloaded: { bytes: number };
    try {
      downloaded = await deps.downloadImage(message.image_url, destPath);
    } catch (err) {
      // Release this attempt's inflight claim: the retry (or QStash's
      // retry of the 500) claims its own when it runs, so a stuck counter
      // must not make every later finalize wait out its cap.
      await releaseInflight();
      if (attempt < INGEST_MAX_DOWNLOAD_RETRIES) {
        log.warn("ingest: photo download failed — re-enqueueing ingest", {
          listingId,
          mid: message.mid,
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        await deps.enqueue(
          "ingest",
          { kind: "ingest", message, attempt: attempt + 1 },
          {
            delaySec: INGEST_DOWNLOAD_RETRY_DELAY_SEC,
            deduplicationId: `${message.mid}-retry-${attempt + 1}`,
          },
        );
        return { action: "photo-retry", listingId };
      }
      throw err;
    }
    downloadedBytes = downloaded.bytes;

    const photo: ListingPhoto = {
      storage_path: destPath,
      w: 0, // Phase 3 fills real dimensions + phash during processing
      h: 0,
      phash: "",
      received_at: now,
    };
    // Second transaction: append the downloaded photo. The alreadySaved
    // check above ran before the download, so re-check here — a concurrent
    // retry of this same mid could have appended it meanwhile.
    await deps.mutateListing(listingId, (doc) => {
      // Release this attempt's inflight claim in the same transaction as
      // the append, so finalize can never observe "appended but still
      // in-flight" (or the reverse).
      const inflight = Math.max(0, (doc.inflight_photos ?? 1) - 1);
      if (doc.photos.some((p) => p.storage_path === destPath)) {
        return {
          patch: { last_photo_at: now, last_activity_at: now, inflight_photos: inflight },
          result: true,
        };
      }
      return {
        patch: {
          photos: [...doc.photos, photo],
          last_photo_at: now,
          last_activity_at: now,
          inflight_photos: inflight,
        },
        result: false,
      };
    });
  } else {
    log.info("ingest: duplicate photo delivery skipped", { listingId });
  }
  await deps.saveConversation(igsid, {
    state: "COLLECTING",
    active_listing_id: listingId,
    last_user_msg_at: now,
    window_open: true,
  });

  // (Re)arm the photo debounce timer. finalize-photos skips itself when
  // last_photo_at has moved on (a newer photo re-armed the timer), and when
  // last_activity_at has moved on (a details text re-armed it — see
  // lib/conversation.ts). activity_at carries this photo's instant so the
  // finalize can tell a quiet burst from one still arriving.
  await deps.enqueue(
    "finalize-photos",
    { kind: "finalize-photos", listing_id: listingId, photo_at: now, activity_at: now },
    {
      delaySec: deps.getPhotoDebounceSeconds(),
      deduplicationId: `finalize-${listingId}-${now}`,
    },
  );

  if (!alreadySaved) log.info("ingest: photo saved", { listingId, bytes: downloadedBytes });
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
      return handleImage(message, deps, now, payload.attempt ?? 0);
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
