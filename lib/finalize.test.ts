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

function payload(listingId: string, photoAt: string): FinalizePhotosPayload {
  return { kind: "finalize-photos", listing_id: listingId, photo_at: photoAt };
}

async function seedListing(status: "DRAFT" | "NEEDS_INFO" = "DRAFT") {
  const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
  listing.status = status;
  listing.last_photo_at = NOW;
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

  it("skips when the listing already left the processable states", async () => {
    await seedListing();
    deps.fdb.listings.get("lst_1")!.status = "SUBMITTED";
    const res = await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    expect(res).toEqual({ ok: true, skipped: "status" });
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

describe("handleFinalizePhotos: error paths (fail closed)", () => {
  it("Gemini failure → NEEDS_REVIEW + alert, never auto-pass", async () => {
    await seedListing();
    deps.gemini.extractListingImpl = async () => {
      throw new Error("503 overloaded");
    };

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_REVIEW");
    expect(deps.alerts).toHaveLength(1);
    expect(deps.meta.sent).toHaveLength(1);
  });

  it("photo download failure → NEEDS_REVIEW", async () => {
    await seedListing();
    deps.downloads.clear();

    await handleFinalizePhotos(payload("lst_1", NOW), fdeps);
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
