/**
 * Phase 1 — ingest unit tests: processIngest with in-memory fakes
 * (no Firebase, no network, no QStash).
 */
import { describe, expect, it } from "vitest";
import { processIngest, type EnqueueFn, type IngestDeps } from "./ingest";
import { blankListingDoc } from "./db";
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

function makeDeps(): {
  deps: IngestDeps;
  enqueued: Enqueued[];
  downloads: { url: string; dest: string }[];
  listings: Map<string, ListingDoc>;
  convs: Map<string, ConversationDoc>;
} {
  const listings = new Map<string, ListingDoc>();
  const convs = new Map<string, ConversationDoc>();
  const enqueued: Enqueued[] = [];
  const downloads: { url: string; dest: string }[] = [];
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
    getOrCreateActiveListing: async (igsid, nowIso) =>
      locks(`conv:${igsid}`, async () => {
        const convoSnap = convs.get(igsid);
        const convo = convoSnap ? structuredClone(convoSnap) : null;
        if (convo?.active_listing_id) {
          const existing = listings.get(convo.active_listing_id);
          if (existing && (existing.status === "DRAFT" || existing.status === "NEEDS_INFO")) {
            return { listing: existing, isNew: false };
          }
        }
        const id = ++idSeq === 1 ? "lst_test123" : `lst_test${idSeq}`;
        const doc = blankListingDoc(id, igsid, nowIso);
        listings.set(id, doc);
        const c = convo ?? blankTestConversation(igsid);
        c.active_listing_id = id;
        c.state = "COLLECTING";
        c.last_user_msg_at = nowIso;
        c.window_open = true;
        convs.set(igsid, c);
        return { listing: doc, isNew: true };
      }),
    enqueue: (async (route, payload, opts) => {
      enqueued.push({ route, payload, opts });
    }) as EnqueueFn,
    getPhotoDebounceSeconds: () => 25,
    nowIso: () => NOW,
  };
  return { deps, enqueued, downloads, listings, convs };
}

describe("processIngest — image", () => {
  it("creates a DRAFT listing, stores the photo, arms the debounce timer", async () => {
    const { deps, enqueued, downloads, listings, convs } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });

    const res = await processIngest({ kind: "ingest", message: msg }, deps);

    expect(res.action).toBe("photo-saved");
    expect(res.listingId).toBe("lst_test123");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.dest).toBe("raw/lst_test123/m_img1.jpg");
    const listing = listings.get("lst_test123");
    expect(listing?.status).toBe("DRAFT");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.photos[0]?.storage_path).toBe("raw/lst_test123/m_img1.jpg");
    expect(listing?.last_photo_at).toBe(NOW);
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
    expect(listing?.photos[1]?.storage_path).toBe("raw/lst_test123/m_img2.jpg");
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
    expect(listing?.photos.map((p) => p.storage_path).sort()).toEqual([
      "raw/lst_test123/m_b1.jpg",
      "raw/lst_test123/m_b2.jpg",
      "raw/lst_test123/m_b3.jpg",
    ]);
  });

  it("a duplicate delivery of the same photo (same mid) appends it only once", async () => {
    const { deps, downloads, listings } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });
    await processIngest({ kind: "ingest", message: msg }, deps);
    // QStash retries the whole ingest (same mid → same storage_path).
    await processIngest({ kind: "ingest", message: msg }, deps);
    const listing = listings.get("lst_test123");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.photos[0]?.storage_path).toBe("raw/lst_test123/m_img1.jpg");
    // The second delivery skips the download too (the CDN URL may be expired).
    expect(downloads).toHaveLength(1);
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
    expect(downloads[0]?.dest).toBe("raw/lst_test123/mid__cAAx_y_z.jpg");
  });

  it("hands an image without image_url to the message worker (never crashes)", async () => {
    const { deps, enqueued, downloads } = makeDeps();
    const res = await processIngest({ kind: "ingest", message: makeInbound("image", "m_bad") }, deps);
    expect(res.action).toBe("enqueued-message");
    expect(downloads).toHaveLength(0);
    expect(enqueued[0]?.route).toBe("message");
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
