/**
 * Phase 2 — handleFinalizePhotos tests with in-memory fakes.
 * lib/moderation (Phase 3) is mocked; Gemini is a fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./moderation", () => ({
  applyModeration: vi.fn(),
}));

import { applyModeration } from "./moderation";
import { handleFinalizePhotos } from "./finalize";
import { GeminiError } from "./gemini";
import {
  IGSID,
  NOW,
  blankTestExtracted,
  fullTestExtracted,
  makeFakeDeps,
  makeFinalizeDeps,
  makePhoto,
  makeVisionResult,
  type FakeDeps,
} from "./test-fakes";
import type { FinalizeDeps } from "./finalize";
import type { FinalizePhotosPayload } from "./types";

const mockApplyModeration = vi.mocked(applyModeration);

let deps: FakeDeps;
let fdeps: FinalizeDeps;

function payload(
  listingId: string,
  photoAt: string,
  attempt?: number,
  activityAt?: string,
  inflightWaits?: number,
): FinalizePhotosPayload {
  const p: FinalizePhotosPayload = { kind: "finalize-photos", listing_id: listingId, photo_at: photoAt };
  if (attempt !== undefined) p.attempt = attempt;
  if (activityAt !== undefined) p.activity_at = activityAt;
  if (inflightWaits !== undefined) p.inflight_waits = inflightWaits;
  return p;
}

async function seedListing(status: "DRAFT" | "NEEDS_INFO" = "DRAFT") {
  const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
  listing.status = status;
  listing.last_photo_at = NOW;
  listing.last_activity_at = NOW;
  listing.chat_text = "zara blazer bechna hai";
  listing.photos = [
    makePhoto("sellers/x/0.jpg"),
    makePhoto("sellers/x/1.jpg"),
  ];
  await deps.db.createListing(listing);
  deps.downloads.set("sellers/x/0.jpg", Buffer.from("img0"));
  deps.downloads.set("sellers/x/1.jpg", Buffer.from("img1"));
  const convo = await deps.db.getOrCreateConversation(IGSID);
  convo.state = "COLLECTING";
  convo.active_listing_id = "lst_1";
  convo.last_user_msg_at = NOW;
  return listing;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps = makeFakeDeps();
  fdeps = makeFinalizeDeps(deps);
  mockApplyModeration.mockResolvedValue({ verdict: "PASS", reasons: [] });
  deps.gemini.extractListingImpl = async (bufs) => {
    expect(bufs).toHaveLength(2); // both photos downloaded
    return makeVisionResult();
  };
});

describe("handleFinalizePhotos: guards", () => {
  it("skips when the listing is missing", async () => {
    const res = await handleFinalizePhotos(payload("nope", NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "listing_missing" });
  });

  it("skips a stale timer (last_photo_at moved on — debounce re-armed)", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.last_photo_at = "2026-09-30T17:06:30.000Z"; // newer photo arrived
    const res = await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "rearmed" });
    expect(deps.gemini.extractListingImpl).toBeDefined();
    // No vision call happened.
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("skips when a details text re-armed the timer (activity moved on)", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.last_activity_at = "2026-09-30T17:06:00.000Z"; // text arrived after arming
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "rearmed" });
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("skips when the listing has no photos (never fail closed on empty buffers)", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.photos = [];
    deps.gemini.extractListingImpl = async () => {
      throw new Error("extractListing must not run with no photos");
    };
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "no_photos" });
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("DRAFT");
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("skips when the listing already left the processable states", async () => {
    await seedListing();
    deps.fdb.listings.get("lst_1")!.status = "SUBMITTED";
    const res = await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "status" });
  });
});

describe("handleFinalizePhotos: burst-combine — activity during extraction", () => {
  const LATE = "2026-09-30T17:06:00.000Z";

  it("discards the extraction and re-arms when a text lands mid-extraction", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // A details text arrives while Gemini is thinking — the burst is not settled.
      await deps.db.mutateListing("lst_1", (doc) => ({
        patch: { chat_text: `${doc.chat_text ?? ""}\nBrand: Late Brand`, last_activity_at: LATE },
        result: undefined,
      }));
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "rearmed" });
    // Nothing from the stale extraction was saved or branched on.
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.extracted).toBeNull();
    expect(listing.status).toBe("DRAFT");
    expect(deps.fdb.events.some((e) => e.event.type === "finalized")).toBe(false);
    expect(deps.fdb.events.some((e) => e.event.type === "finalize_rearmed")).toBe(true);
    const rearmed = deps.enqueued.filter((e) => e.route === "finalize-photos");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.opts?.delaySec).toBe(25);
    expect(rearmed[0]?.payload).toMatchObject({
      kind: "finalize-photos",
      listing_id: "lst_1",
      photo_at: NOW,
      activity_at: LATE,
      rearm: 1,
    });
  });

  it("proceeds after the re-arm cap instead of looping forever", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      await deps.db.mutateListing("lst_1", (_doc) => ({
        patch: { last_activity_at: LATE },
        result: undefined,
      }));
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 4 },
      fdeps,
    );
    expect(res).toEqual({ ok: true });
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.extracted).not.toBeNull();
    expect(listing.status).toBe("CONFIRM"); // makeVisionResult is a complete extraction
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
  });

  it("a transient-failure retry preserves activity_at and rearm", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      throw new GeminiError("extractListing: boom", true);
    };
    const res = await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 1 },
      fdeps,
    );
    expect(res).toEqual({ ok: true });
    const retry = deps.enqueued.find((e) => e.route === "finalize-photos");
    expect(retry).toBeDefined();
    expect(retry!.payload).toMatchObject({
      kind: "finalize-photos",
      listing_id: "lst_1",
      photo_at: NOW,
      activity_at: NOW,
      attempt: 1,
      rearm: 1,
    });
    expect(retry!.opts?.delaySec).toBe(60);
  });
});

describe("handleFinalizePhotos: burst fix — in-flight downloads (2026-11-24)", () => {
  it("waits (re-enqueues) while a photo download is in flight instead of extracting a partial burst", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.inflight_photos = 1; // a burst photo's download still running
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "inflight" });
    // No vision call, nothing extracted, listing untouched.
    expect(listing.extracted).toBeNull();
    expect(listing.status).toBe("DRAFT");
    expect(deps.fdb.events.some((e) => e.event.type === "finalized")).toBe(false);
    const waited = deps.enqueued.filter((e) => e.route === "finalize-photos");
    expect(waited).toHaveLength(1);
    expect(waited[0]?.opts?.delaySec).toBe(15);
    expect(waited[0]?.payload).toMatchObject({
      kind: "finalize-photos",
      listing_id: "lst_1",
      photo_at: NOW,
      activity_at: NOW,
      inflight_waits: 1,
    });
    // Fresh dedup id per wait — the plain finalize-{id}-{activity_at} id
    // would be suppressed inside QStash's 10-minute dedup window.
    expect(waited[0]?.opts?.deduplicationId).toBe(`finalize-wait-lst_1-${NOW}-1`);
  });

  it("proceeds after the inflight-wait cap instead of waiting forever", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.inflight_photos = 1; // a download stuck for 2 minutes
    // Both caps hit (8 waits, 4 re-arms) so the run proceeds rather than
    // looping — the 4b check would route to REVIEW if a photo had arrived.
    const res = await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 4, inflight_waits: 8 },
      fdeps,
    );
    expect(res).toEqual({ ok: true });
    expect(listing.extracted).not.toBeNull();
    expect(listing.status).toBe("CONFIRM"); // makeVisionResult is a complete extraction
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
  });

  it("re-arms when a photo appends during extraction even though activity_at did not move", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // A third photo's append lands while Gemini is thinking — but the
      // append carries the same activity_at the first mutate already set
      // before the download, so the old activity-only re-check could not
      // see it and the burst would close on a partial set.
      await deps.db.mutateListing("lst_1", (doc) => ({
        patch: {
          photos: [...doc.photos, makePhoto("sellers/x/2.jpg")],
          last_photo_at: NOW,
          last_activity_at: NOW,
        },
        result: undefined,
      }));
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "rearmed" });
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.extracted).toBeNull();
    expect(listing.status).toBe("DRAFT");
    expect(deps.fdb.events.some((e) => e.event.type === "finalize_rearmed")).toBe(true);
    const rearmed = deps.enqueued.filter((e) => e.route === "finalize-photos");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.payload).toMatchObject({ rearm: 1 });
  });

  it("re-arms when a download is still in flight after extraction", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // A photo's download is still running when extraction finishes —
      // the burst has not settled even though the photo count is unchanged.
      await deps.db.mutateListing("lst_1", (_doc) => ({
        patch: { inflight_photos: 1 },
        result: undefined,
      }));
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "rearmed" });
    expect(deps.fdb.listings.get("lst_1")!.extracted).toBeNull();
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(1);
  });
});

describe("handleFinalizePhotos: stale-run hardening", () => {
  // Same "later" timestamp the re-arm suite uses (its LATE is scoped to its
  // own describe block).
  const LATE = "2026-09-30T17:06:00.000Z";

  it("skips when the admin rejects the listing during extraction (stale run must not overwrite)", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // Admin moves the listing to review while Gemini is thinking.
      deps.fdb.listings.get("lst_1")!.status = "NEEDS_REVIEW";
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "status" });
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_REVIEW");
    expect(listing.extracted).toBeNull();
    expect(deps.fdb.events.some((e) => e.event.type === "finalized")).toBe(false);
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("at the re-arm cap, a photo arriving during extraction routes to review (never auto-confirm an unexamined photo)", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // A third photo lands while Gemini is thinking; the re-arm cap is hit.
      await deps.db.mutateListing("lst_1", (doc) => ({
        patch: {
          photos: [...doc.photos, makePhoto("sellers/x/2.jpg")],
          last_photo_at: LATE,
          last_activity_at: LATE,
        },
        result: undefined,
      }));
      return makeVisionResult();
    };
    const res = await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 4 },
      fdeps,
    );
    expect(res).toEqual({ ok: true });
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_REVIEW");
    expect(deps.fdb.events.some((e) => e.event.type === "needs_review")).toBe(true);
    expect(deps.fdb.events.some((e) => e.event.type === "confirm")).toBe(false);
  });

  it("finalized event carries the fresh photo count, not the pre-vision buffer count", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      await deps.db.mutateListing("lst_1", (doc) => ({
        patch: {
          photos: [...doc.photos, makePhoto("sellers/x/2.jpg")],
          last_photo_at: LATE,
          last_activity_at: LATE,
        },
        result: undefined,
      }));
      return makeVisionResult();
    };
    await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 4 },
      fdeps,
    );
    const fin = deps.fdb.events.find((e) => e.event.type === "finalized");
    expect(fin).toBeDefined();
    expect(fin!.event.photo_count).toBe(3);
  });

  it("fail-closed convo save patches only the fields finalize owns (no stale full-doc overwrite)", async () => {
    await seedListing();
    mockApplyModeration.mockResolvedValue({ verdict: "FAIL", reasons: ["nudity_sexual"] });
    const savedPatches: Array<Record<string, unknown>> = [];
    const origSave = deps.db.saveConversation;
    deps.db.saveConversation = async (igsid, patch) => {
      savedPatches.push({ ...patch });
      return origSave(igsid, patch);
    };
    await handleFinalizePhotos(payload("lst_1", NOW, undefined, NOW), fdeps);
    expect(savedPatches.length).toBeGreaterThan(0);
    for (const p of savedPatches) {
      expect(Object.keys(p).sort()).toEqual(["active_listing_id", "state"]);
    }
  });

  it("a transient-failure retry carries a deduplicationId and fresh activity_at", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      // A NEEDS_INFO answer bumps activity during the failed run without
      // re-arming finalize — the retry must carry the fresh activity or it
      // would skip as 'rearmed' and strand the listing.
      await deps.db.mutateListing("lst_1", (_doc) => ({
        patch: { last_activity_at: LATE },
        result: undefined,
      }));
      throw new GeminiError("extractListing: boom", true);
    };
    const res = await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 1 },
      fdeps,
    );
    expect(res).toEqual({ ok: true });
    const retry = deps.enqueued.find((e) => e.route === "finalize-photos");
    expect(retry).toBeDefined();
    expect(retry!.payload).toMatchObject({ activity_at: LATE, attempt: 1, rearm: 1 });
    expect(retry!.opts?.deduplicationId).toBe(`finalize-retry-lst_1-1-${LATE}`);
  });

  it("retries from different failure cycles get distinct deduplicationIds (same attempt number)", async () => {
    // Two unrelated failure cycles, same attempt number, different fresh
    // activity: the old bare `finalize-retry-{id}-{attempt}` id was identical
    // for both, so QStash could suppress the second cycle's retry inside
    // its dedup window and strand the listing.
    const LATE2 = "2026-09-30T17:09:00.000Z";
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      await deps.db.mutateListing("lst_1", (_doc) => ({
        patch: { last_activity_at: LATE },
        result: undefined,
      }));
      throw new GeminiError("extractListing: boom", true);
    };
    await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: NOW, rearm: 1 },
      fdeps,
    );
    // Second cycle: the listing's activity is now LATE, so the payload
    // must carry LATE or the run skips as "rearmed".
    deps.gemini.extractListingImpl = async () => {
      await deps.db.mutateListing("lst_1", (_doc) => ({
        patch: { last_activity_at: LATE2 },
        result: undefined,
      }));
      throw new GeminiError("extractListing: boom", true);
    };
    await handleFinalizePhotos(
      { kind: "finalize-photos", listing_id: "lst_1", photo_at: NOW, activity_at: LATE, rearm: 1 },
      fdeps,
    );
    const retries = deps.enqueued.filter((e) => e.route === "finalize-photos");
    expect(retries).toHaveLength(2);
    const ids = retries.map((r) => r.opts?.deduplicationId);
    expect(ids[0]).toBe(`finalize-retry-lst_1-1-${LATE}`);
    expect(ids[1]).toBe(`finalize-retry-lst_1-1-${LATE2}`);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("handleFinalizePhotos: PASS branch", () => {
  it("complete extraction → CONFIRM + preview + consent buttons", async () => {
    await seedListing();
    const res = await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(res.ok).toBe(true);

    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("CONFIRM");
    expect(listing.extracted!.category).toBe("blazer");
    expect(listing.moderation!.verdict).toBe("PASS");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.text).toMatch(/public/i);
    expect(sent.opts.quickReplies!.map((q) => q.payload)).toContain("consent:post");
    expect(deps.fdb.events.some((e) => e.event.type === "finalized")).toBe(true);
  });

  it("incomplete extraction → NEEDS_INFO + one consolidated question", async () => {
    await seedListing();
    const vision = makeVisionResult({
      extracted: { ...fullTestExtracted(), price_pkr: null },
      missing: ["price_pkr"],
    });
    deps.gemini.extractListingImpl = async () => vision;

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_INFO");
    expect(listing.missing).toEqual(["price_pkr"]);
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("NEEDS_INFO");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.text).toMatch(/price|kimat|2500/i);
  });

  it("<2 photos → NEEDS_INFO asking for photos first", async () => {
    await seedListing();
    const listing = deps.fdb.listings.get("lst_1")!;
    listing.photos = listing.photos.slice(0, 1);
    deps.downloads.delete("sellers/x/1.jpg");
    deps.gemini.extractListingImpl = async () => makeVisionResult({ missing: [] });

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("NEEDS_INFO");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.text).toMatch(/photo|tasveer|2/i);
  });
});

describe("handleFinalizePhotos: moderation branches", () => {
  it("FAIL → REJECTED + polite rejection DM", async () => {
    await seedListing();
    mockApplyModeration.mockResolvedValue({ verdict: "FAIL", reasons: ["counterfeit_claim"] });

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("REJECTED");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("IDLE");
    expect(deps.fdb.convos.get(IGSID)!.active_listing_id).toBeNull();
    expect(deps.meta.sent).toHaveLength(1);
    expect(deps.fdb.events.some((e) => e.event.type === "rejected")).toBe(true);
  });

  it("REVIEW → NEEDS_REVIEW + admin alert + holding DM (fail closed)", async () => {
    await seedListing();
    mockApplyModeration.mockResolvedValue({ verdict: "REVIEW", reasons: ["possible_duplicate"] });

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_REVIEW");
    expect(deps.alerts).toHaveLength(1);
    expect(deps.alerts[0]!.text).toMatch(/Review needed/);
    expect(deps.alerts[0]!.opts).toMatchObject({ listingId: "lst_1" });
    expect(deps.meta.sent).toHaveLength(1); // holding reply, never auto-passed
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("IDLE");
  });
});

describe("handleFinalizePhotos: error paths (retry, then fail closed)", () => {
  it("transient Gemini failure → delayed retry (attempt+1), NOT review yet", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      throw new Error("503 overloaded");
    };

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("DRAFT"); // not failed closed on the first spike
    expect(deps.alerts).toHaveLength(0);
    expect(deps.fdb.events.some((e) => e.event.type === "finalize_retry")).toBe(true);
    const retry = deps.enqueued.find((e) => e.route === "finalize-photos");
    expect(retry).toBeDefined();
    expect(retry!.payload).toMatchObject({ kind: "finalize-photos", listing_id: "lst_1", attempt: 1 });
    expect(retry!.opts?.delaySec).toBe(60);
  });

  it("retry succeeds on the second attempt → CONFIRM", async () => {
    await seedListing();
    let calls = 0;
    deps.gemini.extractListingImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("503 overloaded");
      return makeVisionResult();
    };

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("DRAFT");
    await handleFinalizePhotos(payload("lst_1", NOW, 1), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("CONFIRM");
    expect(calls).toBe(2);
  });

  it("retries exhausted (attempt 2) → NEEDS_REVIEW + alert, never auto-pass", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      throw new Error("503 overloaded");
    };

    await handleFinalizePhotos(payload("lst_1", NOW, 2), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_REVIEW");
    expect(deps.alerts).toHaveLength(1);
    expect(deps.meta.sent).toHaveLength(1);
  });

  it("non-retryable Gemini error → fails closed at once, no retry", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      throw new GeminiError("extractListing: schema validation failed", false);
    };

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("NEEDS_REVIEW");
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
  });

  it("photo download failure → delayed retry first, NEEDS_REVIEW once retries exhaust", async () => {
    await seedListing();
    deps.downloads.clear();

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("DRAFT");
    expect(deps.enqueued.find((e) => e.route === "finalize-photos")).toBeDefined();
    await handleFinalizePhotos(payload("lst_1", NOW, 2), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("NEEDS_REVIEW");
  });

  it("blank extraction result still records finalized event", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () =>
      makeVisionResult({ extracted: blankTestExtracted(), missing: ["category", "size", "condition", "price_pkr", "city"] });

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("NEEDS_INFO");
    expect(deps.fdb.events.some((e) => e.event.type === "finalized")).toBe(true);
  });
});

describe("handleFinalizePhotos: perceptual hashing (duplicate index)", () => {
  it("computes real dhashes from photo bytes and records them", async () => {
    const { default: sharp } = await import("sharp");
    const red = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 30, g: 30, b: 200 } },
    })
      .png()
      .toBuffer();

    await seedListing();
    deps.downloads.set("sellers/x/0.jpg", red);
    deps.downloads.set("sellers/x/1.jpg", blue);

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);

    const listing = deps.fdb.listings.get("lst_1")!;
    const [p0, p1] = listing.photos;
    expect(p0!.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(p1!.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(p0!.phash).not.toBe("a".repeat(16)); // seed placeholder replaced
    expect(deps.fdb.phashes).toHaveLength(2);
    expect(deps.fdb.phashes[0]).toEqual({ phash: p0!.phash, listingId: "lst_1" });
    expect(deps.fdb.phashes[1]).toEqual({ phash: p1!.phash, listingId: "lst_1" });
  });

  it("still records hashes when moderation FAILs (resubmissions must be flaggable)", async () => {
    mockApplyModeration.mockResolvedValue({ verdict: "FAIL", reasons: ["nudity_sexual"] });
    await seedListing();

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);

    expect(deps.fdb.listings.get("lst_1")!.status).toBe("REJECTED");
    expect(deps.fdb.phashes).toHaveLength(2);
    expect(deps.fdb.phashes.every((p) => p.listingId === "lst_1")).toBe(true);
  });

  it("a corrupt image never blocks the listing (hash skipped, flow continues)", async () => {
    await seedListing(); // downloads are garbage buffers ("img0"/"img1")
    const res = await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(res.ok).toBe(true);
    // dhash failed → seed placeholder kept; finalize still reached CONFIRM.
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("CONFIRM");
  });
});
