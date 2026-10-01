/**
 * Phase 3 — moderation verdict matrix tests.
 * ./db is mocked (no Firebase in unit tests); the fail-closed contract is
 * exercised against synthetic ListingDoc + VisionResult fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  isSellerBlocklisted: vi.fn(),
  findDuplicatePhash: vi.fn(),
  findDuplicatePhashEntry: vi.fn(),
  findRecentPhashes: vi.fn(),
}));

import { applyModeration } from "./moderation";
import { findDuplicatePhashEntry, findRecentPhashes, isSellerBlocklisted } from "./db";
import type { ListingDoc, PerImageModeration } from "./types";
import type { VisionResult } from "./gemini";

const blocked = vi.mocked(isSellerBlocklisted);
const exactDup = vi.mocked(findDuplicatePhashEntry);
const recentDup = vi.mocked(findRecentPhashes);

const PHASH_A = "0000000000000000";

function makeListing(overrides: Partial<ListingDoc> = {}): ListingDoc {
  return {
    id: "listing_test_1",
    seller_igsid: "seller_123",
    created_at: new Date().toISOString(),
    status: "DRAFT",
    photos: [
      { storage_path: "raw/x/p1.jpg", w: 800, h: 1000, phash: PHASH_A, received_at: new Date().toISOString() },
    ],
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
    ...overrides,
  };
}

function cleanPerImage(overrides: Partial<PerImageModeration> = {}): PerImageModeration {
  return {
    photo_index: 0,
    is_clothing: true,
    nudity_sexual: false,
    visible_faces: false,
    minors: false,
    offensive_text: false,
    contact_info: false,
    stock_or_stolen_suspicion: false,
    ...overrides,
  };
}

function makeVision(overrides: Partial<VisionResult["moderation"]> = {}): VisionResult {
  return {
    extracted: {
      title: "Test kurti",
      category: "dresses",
      gender: "women",
      brand: null,
      color: "red",
      size: "M",
      condition: "like_new",
      price_pkr: 2500,
      city: "Karachi",
      defects: [],
      measurements: null,
      confidence: {},
    },
    missing: [],
    moderation: {
      verdict: "PASS",
      reasons: [],
      counterfeit_claim: false,
      text_contact_info: false,
      per_image: [cleanPerImage()],
      ...overrides,
    },
  };
}

beforeEach(() => {
  blocked.mockReset().mockResolvedValue(false);
  exactDup.mockReset().mockResolvedValue(null);
  recentDup.mockReset().mockResolvedValue([]);
});

describe("applyModeration verdict matrix", () => {
  it("clean listing → PASS", async () => {
    const out = await applyModeration(makeListing(), makeVision());
    expect(out).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("blocklisted seller → FAIL (checked before anything else)", async () => {
    blocked.mockResolvedValue(true);
    const out = await applyModeration(makeListing(), makeVision());
    expect(out.verdict).toBe("FAIL");
    expect(out.reasons).toEqual(["seller_blocklisted"]);
  });

  it("vision verdict FAIL → FAIL with merged reasons", async () => {
    const out = await applyModeration(
      makeListing(),
      makeVision({ verdict: "FAIL", reasons: ["inappropriate_content"] }),
    );
    expect(out.verdict).toBe("FAIL");
    expect(out.reasons).toContain("inappropriate_content");
    expect(out.reasons).toContain("vision_verdict_fail");
  });

  const severeCases: [string, Partial<PerImageModeration>][] = [
    ["nudity_sexual", { nudity_sexual: true }],
    ["minors", { minors: true }],
    ["offensive_text", { offensive_text: true }],
  ];
  it.each(severeCases)("severe per-image flag %s → FAIL", async (reason, flag) => {
    const out = await applyModeration(
      makeListing(),
      makeVision({ per_image: [cleanPerImage(flag)] }),
    );
    expect(out.verdict).toBe("FAIL");
    expect(out.reasons).toContain(reason);
  });

  const reviewCases: [string, Partial<PerImageModeration>][] = [
    ["visible_faces", { visible_faces: true }],
    ["contact_info_in_image", { contact_info: true }],
    ["stock_or_stolen_suspicion", { stock_or_stolen_suspicion: true }],
  ];
  it.each(reviewCases)("suspicion per-image flag %s → REVIEW", async (reason, flag) => {
    const out = await applyModeration(
      makeListing(),
      makeVision({ per_image: [cleanPerImage(flag)] }),
    );
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain(reason);
  });

  it("counterfeit_claim → REVIEW", async () => {
    const out = await applyModeration(makeListing(), makeVision({ counterfeit_claim: true }));
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain("counterfeit_claim");
  });

  it("text_contact_info → REVIEW", async () => {
    const out = await applyModeration(makeListing(), makeVision({ text_contact_info: true }));
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain("text_contact_info");
  });

  it("no clothing detected on any photo → REVIEW", async () => {
    const out = await applyModeration(
      makeListing(),
      makeVision({ per_image: [cleanPerImage({ is_clothing: false })] }),
    );
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain("no_clothing_detected");
  });

  it("FAIL wins over REVIEW flags", async () => {
    const out = await applyModeration(
      makeListing(),
      makeVision({ per_image: [cleanPerImage({ visible_faces: true, minors: true })] }),
    );
    expect(out.verdict).toBe("FAIL");
    expect(out.reasons).toContain("minors");
    expect(out.reasons).toContain("visible_faces");
  });
});

describe("applyModeration duplicate detection", () => {
  it("exact dHash match on a DIFFERENT listing → REVIEW possible_duplicate", async () => {
    exactDup.mockResolvedValue({ phash: PHASH_A, listing_id: "listing_other", at: new Date().toISOString() });
    const out = await applyModeration(makeListing(), makeVision());
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain("possible_duplicate");
  });

  it("exact dHash match on the SAME listing is not a duplicate", async () => {
    exactDup.mockResolvedValue({ phash: PHASH_A, listing_id: "listing_test_1", at: new Date().toISOString() });
    const out = await applyModeration(makeListing(), makeVision());
    expect(out.verdict).toBe("PASS");
  });

  it("near-duplicate (Hamming ≤ 6) on a different listing → REVIEW", async () => {
    // "000000000000000f" differs from PHASH_A in 4 bits.
    recentDup.mockResolvedValue([
      { phash: "000000000000000f", listing_id: "listing_other", at: new Date().toISOString() },
    ]);
    const out = await applyModeration(makeListing(), makeVision());
    expect(out.verdict).toBe("REVIEW");
    expect(out.reasons).toContain("possible_duplicate");
  });

  it("distant hash (>6) is not a duplicate", async () => {
    recentDup.mockResolvedValue([
      { phash: "ffffffffffffffff", listing_id: "listing_other", at: new Date().toISOString() },
    ]);
    const out = await applyModeration(makeListing(), makeVision());
    expect(out.verdict).toBe("PASS");
  });
});

describe("applyModeration fail-closed", () => {
  it("blocklist lookup error → REVIEW moderation_error (never PASS)", async () => {
    blocked.mockRejectedValue(new Error("firestore down"));
    const out = await applyModeration(makeListing(), makeVision());
    expect(out).toEqual({ verdict: "REVIEW", reasons: ["moderation_error"] });
  });

  it("duplicate-index error → REVIEW moderation_error", async () => {
    exactDup.mockRejectedValue(new Error("firestore down"));
    const out = await applyModeration(makeListing(), makeVision());
    expect(out).toEqual({ verdict: "REVIEW", reasons: ["moderation_error"] });
  });
});
