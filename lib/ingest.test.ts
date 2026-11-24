/**
 * Phase 1 — ingest unit tests: processIngest with in-memory fakes
 * (no Firebase, no network, no QStash).
 */
import { describe, expect, it } from "vitest";
import { processIngest, type EnqueueFn, type IngestDeps } from "./ingest";
import { blankListingDoc, pktDay } from "./db";
import { blankTestConversation, makeKeyedMutex } from "./test-fakes";
import type {
  ConversationDoc,
  ListingDoc,
  NormalizedInbound,
  WorkerKind,
  WorkerPayload,
} from "./types";

const NOW = "2026-09-30T17:05:00.000Z";
const IGSID = "98765432109876543";
const IGID = "17841400008460056";

interface Enqueued {
  route: WorkerKind;
  payload: WorkerPayload;
  opts?: { delaySec?: number; notBefore?: number; deduplicationId?: string } | undefined;
}

function makeInbound(kind: NormalizedInbound["kind"], mid: string, extra: Partial<NormalizedInbound> = {}): NormalizedInbound {
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

function makeDeps(opts: { maxPerDay?: number } = {}): {
  deps: IngestDeps;
  enqueued: Enqueued[];
  downloads: { url: string; dest: string }[];
  listings: Map<string, ListingDoc>;
  convs: Map<string, ConversationDoc>;
  savedInbounds: NormalizedInbound[];
} {
  const listings = new Map<string, ListingDoc>();
  const convs = new Map<string, ConversationDoc>();
  const enqueued: Enqueued[] = [];
  const downloads: { url: string; dest: string }[] = [];
  const savedInbounds: NormalizedInbound[] = [];
  const maxPerDay = opts.maxPerDay ?? 5;
  let idSeq = 0;
  // Same serialization the real Firestore transactions provide, so burst
  // tests exercise the same interleaving production sees.
  const locks = makeKeyedMutex();

  const deps: IngestDeps = {
    downloadImage: async (url, dest) => {
      downloads.push({ url, dest });
      return { bytes: 4242 };
    },
    saveConversation: async (igsid, patch) => {
      const cur = convs.get(igsid) ?? blankTestConversation(igsid);
      const next = { ...cur, ...patch, igsid };
      convs.set(igsid, next);
      return next;
    },
    mutateListing: async (id, mutate) =>
      locks(id, async () => {
        const doc = listings.get(id);
        if (!doc) throw new Error(`listing ${id} not found`);
        // Firestore-style snapshot: the mutator works on a detached copy, so
        // without the lock two concurrent mutates would lose each other's
        // writes (the exact burst race this guards against).
        const snap = structuredClone(doc);
        const { patch, result } = mutate(snap);
        Object.assign(doc, patch);
        return result;
      }),
    getOrCreateActiveListing: async (igsid, nowIso, maxPerDayArg) =>
      locks(`conv:${igsid}`, async () => {
        const convoSnap = convs.get(igsid);
        const convo = convoSnap ? structuredClone(convoSnap) : null;
        if (convo?.active_listing_id) {
          const existing = listings.get(convo.active_listing_id);
          if (existing && (existing.status === "DRAFT" || existing.status === "NEEDS_INFO")) {
            return { listing: existing, isNew: false };
          }
        }
        // Mirror prod (lib/db.ts): daily limit enforced in the create
        // transaction; a reuse above never consumes a slot.
        const today = pktDay(new Date(nowIso));
        const effectiveToday = convo && convo.listings_day === today ? convo.listings_today : 0;
        const cap = maxPerDayArg ?? maxPerDay;
        if (effectiveToday >= cap) {
          return { listing: null, isNew: false, limitReached: true };
        }
        const id = ++idSeq === 1 ? "lst_test123" : `lst_test${idSeq}`;
        const doc = blankListingDoc(id, igsid, nowIso);
        listings.set(id, doc);
        const c = convo ?? blankTestConversation(igsid);
        c.active_listing_id = id;
        c.state = "COLLECTING";
        c.last_user_msg_at = nowIso;
        c.window_open = true;
        c.listings_today = effectiveToday + 1;
        c.listings_day = today;
        convs.set(igsid, c);
        return { listing: doc, isNew: true, listingsToday: effectiveToday + 1, listingsDay: today };
      }),
    enqueue: (async (route, payload, opts) => {
      enqueued.push({ route, payload, opts });
    }) as EnqueueFn,
    getPhotoDebounceSeconds: () => 25,
    getMaxListingsPerSellerPerDay: () => maxPerDay,
    saveInbound: async (inbound) => {
      savedInbounds.push(inbound);
    },
    nowIso: () => NOW,
  };
  return { deps, enqueued, downloads, listings, convs, savedInbounds };
}

describe("processIngest — image", () => {
  it("creates a DRAFT listing, stores the photo, arms the debounce timer", async () => {
    const { deps, enqueued, downloads, listings, convs } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });

    const res = await processIngest({ kind: "ingest", message: msg }, deps);

    expect(res.action).toBe("photo-saved");
    expect(res.listingId).toBe("lst_test123");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.dest).toBe("raw/lst_test123/m_img1-90e24fd0886759f1.jpg");
    const listing = listings.get("lst_test123");
    expect(listing?.status).toBe("DRAFT");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.photos[0]?.storage_path).toBe("raw/lst_test123/m_img1-90e24fd0886759f1.jpg");
    expect(listing?.last_photo_at).toBe(NOW);
    expect(listing?.last_activity_at).toBe(NOW); // burst-combine: photo bumps activity too
    const conv = convs.get(IGSID);
    expect(conv?.state).toBe("COLLECTING");
    expect(conv?.active_listing_id).toBe("lst_test123");
    expect(conv?.window_open).toBe(true);

    const finalize = enqueued.filter((e) => e.route === "finalize-photos");
    expect(finalize).toHaveLength(1);
    expect(finalize[0]?.opts?.delaySec).toBe(25);
    const p = finalize[0]?.payload;
    expect(p?.kind).toBe("finalize-photos");
    if (p?.kind === "finalize-photos") {
      expect(p.listing_id).toBe("lst_test123");
      expect(p.photo_at).toBe(NOW);
      expect(p.activity_at).toBe(NOW); // burst-combine: finalize carries the activity instant
    }
  });

  it("reuses the sender's active DRAFT listing for a second photo", async () => {
    const { deps, enqueued, listings } = makeDeps();
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    // A second message arrives 3s later (different photo_at).
    const deps2 = { ...deps, nowIso: () => "2026-09-30T17:05:03.000Z" };
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img2", { image_url: "https://cdn.example/b.jpg" }) },
      deps2,
    );
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(2);
    expect(listing?.photos[1]?.storage_path).toBe("raw/lst_test123/m_img2-0f0e5934d02300a4.jpg");
    // Two debounce timers armed — the older one self-skips on photo_at mismatch.
    expect(enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(2);
  });

  it("burst of 3 concurrent photos all land in one listing (2026-11-23: Nina sent 3, only 1 survived)", async () => {
    const { deps, listings } = makeDeps();
    const at = (s: string) => ({ ...deps, nowIso: () => `2026-09-30T17:05:${s}.000Z` });
    const results = await Promise.all([
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_b1", { image_url: "https://cdn.example/1.jpg" }) },
        at("00"),
      ),
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_b2", { image_url: "https://cdn.example/2.jpg" }) },
        at("01"),
      ),
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_b3", { image_url: "https://cdn.example/3.jpg" }) },
        at("02"),
      ),
    ]);
    // One listing, not three — the concurrent creates must not split the burst.
    expect(listings.size).toBe(1);
    expect(results.map((r) => r.listingId)).toEqual(["lst_test123", "lst_test123", "lst_test123"]);
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(3);
    // Per-attachment storage paths (Fix #37, 2026-11-24): one message's N
    // attachments share one mid, so the path carries a short hash of the
    // CDN URL — without it photos 2+ collide with photo 1's path and are
    // skipped as "duplicate photo delivery".
    expect(listing?.photos.map((p) => p.storage_path).sort()).toEqual([
      "raw/lst_test123/m_b1-739cdeb6c6b33ec5.jpg",
      "raw/lst_test123/m_b2-35f95b87ed9df7cd.jpg",
      "raw/lst_test123/m_b3-1c30a7ea03947f48.jpg",
    ]);
    // Burst fix (2026-11-24): every download's inflight claim is released
    // once its photo lands, so a later finalize never waits on a stale count.
    expect(listing?.inflight_photos).toBe(0);
  });

  it("three photos sharing ONE mid (one message, N attachments) all save — Fix #37 (2026-11-24 live test: 3 sent, 1 saved)", async () => {
    const { deps, listings } = makeDeps();
    // Instagram fans one message's N attachments out to N inbounds sharing
    // one mid (see lib/webhook.ts inboundDedupId). The storage path must be
    // per-attachment, or photos 2+ collide with photo 1's path and are
    // skipped as "duplicate photo delivery".
    const at = (s: string) => ({ ...deps, nowIso: () => `2026-09-30T17:05:${s}.000Z` });
    const results = await Promise.all([
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_shared", { image_url: "https://cdn.example/1.jpg" }) },
        at("00"),
      ),
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_shared", { image_url: "https://cdn.example/2.jpg" }) },
        at("01"),
      ),
      processIngest(
        { kind: "ingest", message: makeInbound("image", "m_shared", { image_url: "https://cdn.example/3.jpg" }) },
        at("02"),
      ),
    ]);
    expect(results.map((r) => r.listingId)).toEqual(["lst_test123", "lst_test123", "lst_test123"]);
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(3);
    expect(listing?.photos.map((p) => p.storage_path).sort()).toEqual([
      "raw/lst_test123/m_shared-1c30a7ea03947f48.jpg",
      "raw/lst_test123/m_shared-35f95b87ed9df7cd.jpg",
      "raw/lst_test123/m_shared-739cdeb6c6b33ec5.jpg",
    ]);
    expect(listing?.inflight_photos).toBe(0);
  });

  it("inflight counter is 1 during the download and 0 after the append (burst fix 2026-11-24)", async () => {
    const { deps, listings } = makeDeps();
    const seenDuringDownload: (number | undefined)[] = [];
    deps.downloadImage = async () => {
      // The finalize guard reads this counter: while the download is in
      // flight it must be 1, so a finalize cannot close the burst early.
      seenDuringDownload.push(listings.get("lst_test123")?.inflight_photos);
      return { bytes: 4242 };
    };
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    expect(seenDuringDownload).toEqual([1]);
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.inflight_photos).toBe(0);
  });

  it("a duplicate delivery of the same photo (same mid) appends it only once", async () => {
    const { deps, downloads, listings } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });
    await processIngest({ kind: "ingest", message: msg }, deps);
    // QStash retries the whole ingest (same mid → same storage_path).
    await processIngest({ kind: "ingest", message: msg }, deps);
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.photos[0]?.storage_path).toBe("raw/lst_test123/m_img1-90e24fd0886759f1.jpg");
    // The second delivery skips the download too (the CDN URL may be expired).
    expect(downloads).toHaveLength(1);
    // A duplicate delivery never claims an inflight download.
    expect(listing?.inflight_photos).toBe(0);
  });

  it("appends a photo to the active NEEDS_INFO listing instead of starting a new one", async () => {
    const { deps, listings } = makeDeps();
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    // The bot asked for a missing photo; the seller's next photo belongs to
    // the SAME listing (previously ingest only reused DRAFT and split it).
    listings.get("lst_test123")!.status = "NEEDS_INFO";
    const res = await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img9", { image_url: "https://cdn.example/z.jpg" }) },
      { ...deps, nowIso: () => "2026-09-30T17:05:03.000Z" },
    );
    expect(res.listingId).toBe("lst_test123");
    expect(listings.get("lst_test123")?.photos).toHaveLength(2);
    expect(listings.size).toBe(1);
  });

  it("starts a new listing when the active one is SUBMITTED", async () => {
    const { deps, listings } = makeDeps();
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    listings.get("lst_test123")!.status = "SUBMITTED";
    const res = await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img9", { image_url: "https://cdn.example/z.jpg" }) },
      { ...deps, nowIso: () => "2026-09-30T17:05:03.000Z" },
    );
    expect(res.listingId).toBe("lst_test2");
    expect(listings.size).toBe(2);
  });

  it("sanitizes mids with unsafe characters for the storage path", async () => {
    const { deps, downloads } = makeDeps();
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "mid.$cAAx:y/z", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    expect(downloads[0]?.dest).toBe("raw/lst_test123/mid__cAAx_y_z-90e24fd0886759f1.jpg");
  });

  it("a failed CDN download re-enqueues the ingest itself (bounded) instead of losing the photo", async () => {
    const { deps, enqueued, downloads, listings } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });
    let calls = 0;
    deps.downloadImage = async (url, dest) => {
      calls += 1;
      downloads.push({ url, dest });
      if (calls === 1) throw new Error("image download failed: HTTP 500");
      return { bytes: 4242 };
    };

    // First delivery: download fails → self-retry scheduled, photo not lost.
    const res = await processIngest({ kind: "ingest", message: msg }, deps);
    expect(res.action).toBe("photo-retry");
    expect(listings.get("lst_test123")?.photos).toHaveLength(0);
    // Burst fix (2026-11-24): the failed attempt releases its inflight
    // claim — the retry claims its own when it runs, so the counter must
    // not stay stuck at 1 and make every later finalize wait out its cap.
    expect(listings.get("lst_test123")?.inflight_photos).toBe(0);
    expect(enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
    const retry = enqueued.filter((e) => e.route === "ingest");
    expect(retry).toHaveLength(1);
    expect(retry[0]?.opts?.delaySec).toBe(30);
    expect(retry[0]?.opts?.deduplicationId).toBe("m_img1-retry-1");
    const rp = retry[0]?.payload;
    expect(rp?.kind).toBe("ingest");
    if (rp?.kind === "ingest") expect(rp.attempt).toBe(1);

    // The retry (attempt 1) downloads fine → photo saved, finalize armed.
    const res2 = await processIngest({ kind: "ingest", message: msg, attempt: 1 }, deps);
    expect(res2.action).toBe("photo-saved");
    expect(listings.get("lst_test123")?.photos).toHaveLength(1);
    expect(enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(1);
  });

  it("a download that keeps failing past the retry budget throws (route 500 → QStash retries)", async () => {
    const { deps } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });
    deps.downloadImage = async () => {
      throw new Error("image download failed: HTTP 500");
    };
    await expect(processIngest({ kind: "ingest", message: msg, attempt: 2 }, deps)).rejects.toThrow(
      "image download failed",
    );
  });

  it("hands an image without image_url to the message worker (never crashes)", async () => {
    const { deps, enqueued, downloads } = makeDeps();
    const res = await processIngest({ kind: "ingest", message: makeInbound("image", "m_bad") }, deps);
    expect(res.action).toBe("enqueued-message");
    expect(downloads).toHaveLength(0);
    expect(enqueued[0]?.route).toBe("message");
  });

  it("photo-first at the daily limit → limit-reached, no download, limit reply enqueued", async () => {
    const { deps, enqueued, downloads, listings, convs, savedInbounds } = makeDeps({ maxPerDay: 1 });
    convs.set(IGSID, { ...blankTestConversation(IGSID), listings_today: 1, listings_day: "2026-09-30" });
    const res = await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    expect(res.action).toBe("limit-reached");
    expect(res.listingId).toBeUndefined();
    expect(downloads).toHaveLength(0); // photo never downloaded
    expect(listings.size).toBe(0); // no listing created
    expect(enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
    expect(savedInbounds).toHaveLength(1); // message route needs the inbound to send the reply
    const msg = enqueued.filter((e) => e.route === "message");
    expect(msg).toHaveLength(1);
    expect(msg[0]?.payload).toMatchObject({ kind: "message", igsid: IGSID, mid: "m_img1", limit_reply: true });
  });

  it("photo-first counts the new listing; a second listing the same day is blocked but reuse is not", async () => {
    const { deps, enqueued, downloads, listings, convs } = makeDeps({ maxPerDay: 1 });
    const photo = (mid: string, url: string) =>
      processIngest({ kind: "ingest", message: makeInbound("image", mid, { image_url: url }) }, deps);

    // First photo creates listing #1 and consumes the day's only slot.
    expect((await photo("m_img1", "https://cdn.example/a.jpg")).action).toBe("photo-saved");
    expect(convs.get(IGSID)?.listings_today).toBe(1);
    // Second photo reuses the same active listing — no new slot consumed.
    expect((await photo("m_img2", "https://cdn.example/b.jpg")).action).toBe("photo-saved");
    expect(convs.get(IGSID)?.listings_today).toBe(1);
    expect(listings.get("lst_test123")?.photos).toHaveLength(2);
    // Once listing #1 is submitted, a new photo would start listing #2 —
    // over the limit, so it is dropped.
    listings.get("lst_test123")!.status = "SUBMITTED";
    expect((await photo("m_img3", "https://cdn.example/c.jpg")).action).toBe("limit-reached");
    expect(downloads).toHaveLength(2); // only the first two photos downloaded
    expect(listings.size).toBe(1);
    expect(enqueued.filter((e) => e.route === "message" && e.payload.kind === "message" && e.payload.limit_reply)).toHaveLength(1);
  });
});

describe("processIngest — text / quick_reply / unsupported", () => {
  it.each(["text", "quick_reply", "unsupported"] as const)("enqueues the message worker for %s", async (kind) => {
    const { deps, enqueued } = makeDeps();
    const res = await processIngest(
      {
        kind: "ingest",
        message: makeInbound(kind, "m_x", {
          text: kind === "text" ? "hello" : null,
          quick_reply_payload: kind === "quick_reply" ? "CONFIRM_POST" : null,
          unsupported_hint: kind === "unsupported" ? "sticker" : null,
        }),
      },
      deps,
    );
    expect(res.action).toBe("enqueued-message");
    expect(enqueued).toHaveLength(1);
    const p = enqueued[0]?.payload;
    expect(enqueued[0]?.route).toBe("message");
    expect(p).toEqual({ kind: "message", igsid: IGSID, mid: "m_x" });
  });
});

describe("processIngest — echo / unknown", () => {
  it.each(["echo", "unknown"] as const)("ignores %s without side effects", async (kind) => {
    const { deps, enqueued, downloads } = makeDeps();
    const res = await processIngest({ kind: "ingest", message: makeInbound(kind, "m_y") }, deps);
    expect(res.action).toBe("ignored");
    expect(enqueued).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });
});
