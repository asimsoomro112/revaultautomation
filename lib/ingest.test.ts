/**
 * Phase 1 — ingest unit tests: processIngest with in-memory fakes
 * (no Firebase, no network, no QStash).
 */
import { describe, expect, it } from "vitest";
import { processIngest, type EnqueueFn, type IngestDeps } from "./ingest";
import { blankListingDoc } from "./db";
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

function makeDeps(): { deps: IngestDeps; enqueued: Enqueued[]; downloads: { url: string; dest: string }[] } {
  const listings = new Map<string, ListingDoc>();
  const convs = new Map<string, ConversationDoc>();
  const enqueued: Enqueued[] = [];
  const downloads: { url: string; dest: string }[] = [];

  const deps: IngestDeps = {
    downloadImage: async (url, dest) => {
      downloads.push({ url, dest });
      return { bytes: 4242 };
    },
    getOrCreateConversation: async (igsid) => {
      const existing = convs.get(igsid);
      if (existing) return existing;
      const doc: ConversationDoc = {
        igsid,
        state: "IDLE",
        lang: "roman",
        active_listing_id: null,
        intent: null,
        listings_today: 0,
        listings_day: "2026-09-30",
        last_user_msg_at: null,
        window_open: false,
        human_needed: false,
        blocked: false,
        msg_count_1h: 0,
        msg_window_start: null,
        user_msg_total: 0,
        last_processed_mid: null,
      };
      convs.set(igsid, doc);
      return doc;
    },
    saveConversation: async (igsid, patch) => {
      const cur = convs.get(igsid) ?? (await deps.getOrCreateConversation(igsid));
      const next = { ...cur, ...patch, igsid };
      convs.set(igsid, next);
      return next;
    },
    getListing: async (id) => listings.get(id) ?? null,
    createListing: async (doc) => {
      listings.set(doc.id, doc);
    },
    saveListing: async (id, patch) => {
      const cur = listings.get(id);
      if (!cur) throw new Error(`listing ${id} not found`);
      listings.set(id, { ...cur, ...patch });
    },
    blankListingDoc,
    newListingId: () => "lst_test123",
    enqueue: (async (route, payload, opts) => {
      enqueued.push({ route, payload, opts });
    }) as EnqueueFn,
    getPhotoDebounceSeconds: () => 25,
    nowIso: () => NOW,
  };
  return { deps, enqueued, downloads };
}

describe("processIngest — image", () => {
  it("creates a DRAFT listing, stores the photo, arms the debounce timer", async () => {
    const { deps, enqueued, downloads } = makeDeps();
    const msg = makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" });

    const res = await processIngest({ kind: "ingest", message: msg }, deps);

    expect(res.action).toBe("photo-saved");
    expect(res.listingId).toBe("lst_test123");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.dest).toBe("raw/lst_test123/m_img1.jpg");
    const listing = await deps.getListing("lst_test123");
    expect(listing?.status).toBe("DRAFT");
    expect(listing?.photos).toHaveLength(1);
    expect(listing?.photos[0]?.storage_path).toBe("raw/lst_test123/m_img1.jpg");
    expect(listing?.last_photo_at).toBe(NOW);
    const conv = await deps.getOrCreateConversation(IGSID);
    expect(conv.state).toBe("COLLECTING");
    expect(conv.active_listing_id).toBe("lst_test123");
    expect(conv.window_open).toBe(true);

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
    const { deps, enqueued } = makeDeps();
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
    const listing = await deps.getListing("lst_test123");
    expect(listing?.photos).toHaveLength(2);
    expect(listing?.photos[1]?.storage_path).toBe("raw/lst_test123/m_img2.jpg");
    // Two debounce timers armed — the older one self-skips on photo_at mismatch.
    expect(enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(2);
  });

  it("starts a new listing when the active one is no longer DRAFT", async () => {
    const { deps } = makeDeps();
    await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img1", { image_url: "https://cdn.example/a.jpg" }) },
      deps,
    );
    await deps.saveListing("lst_test123", { status: "NEEDS_INFO" });
    let n = 0;
    const deps2 = { ...deps, newListingId: () => `lst_new${++n}` };
    const res = await processIngest(
      { kind: "ingest", message: makeInbound("image", "m_img9", { image_url: "https://cdn.example/z.jpg" }) },
      deps2,
    );
    expect(res.listingId).toBe("lst_new1");
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
