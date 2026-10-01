/**
 * Phase 3 — caption post-processing tests.
 * Gemini is mocked (contract: getGeminiClient().writeCaption); these tests
 * assert the deterministic guarantees buildCaption adds on top.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { writeCaption } = vi.hoisted(() => ({ writeCaption: vi.fn() }));
vi.mock("./gemini", () => ({
  getGeminiClient: () => ({ writeCaption }),
}));

import { buildCaption } from "./caption";
import { resetEnvCache } from "./env";
import type { ExtractedItem } from "./types";

const mockedWriteCaption = vi.mocked(writeCaption);

function extracted(): ExtractedItem {
  return {
    title: "Red embroidered kurti",
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
  };
}

function countHashtags(s: string): number {
  return (s.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

afterEach(() => {
  mockedWriteCaption.mockReset();
  delete process.env.CAPTION_CTA;
  resetEnvCache();
});

describe("buildCaption post-processing", () => {
  it("appends the DM CTA and 3–5 hashtags when the model omits them", async () => {
    mockedWriteCaption.mockResolvedValue("Red embroidered kurti\nSize M · Rs 2500");
    const out = await buildCaption(extracted(), "roman");
    expect(out).toContain("DM to buy 🤍");
    const n = countHashtags(out);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
    expect(out).toContain("#prelovedpakistan");
    expect(out).toContain("#prelovedkarachi");
  });

  it("does not duplicate a CTA the model already wrote", async () => {
    mockedWriteCaption.mockResolvedValue("Red kurti\n\nDM to buy 🤍\n\n#prelovedpakistan #thriftpakistan #prelovedfashion");
    const out = await buildCaption(extracted(), "en");
    expect(out.match(/dm to buy/gi)?.length).toBe(1);
  });

  it("site CTA appends the shop link", async () => {
    process.env.CAPTION_CTA = "site";
    resetEnvCache();
    mockedWriteCaption.mockResolvedValue("Red kurti");
    const out = await buildCaption(extracted(), "en");
    expect(out).toContain("Shop: https://revaultx.vercel.app");
  });

  it("strips phone numbers and emails defensively (price is kept)", async () => {
    mockedWriteCaption.mockResolvedValue(
      "Red kurti, Rs 2500\nCall 0300 1234567 or mail seller@example.com\n#prelovedpakistan #thriftpakistan #prelovedfashion",
    );
    const out = await buildCaption(extracted(), "en");
    expect(out).not.toContain("0300");
    expect(out).not.toContain("1234567");
    expect(out).not.toContain("seller@example.com");
    expect(out).toContain("Rs 2500");
  });

  it("trims the model's hashtag spam to 5", async () => {
    mockedWriteCaption.mockResolvedValue(
      "Red kurti\n#one #two #three #four #five #six #seven #eight",
    );
    const out = await buildCaption(extracted(), "en");
    expect(countHashtags(out)).toBe(5);
    expect(out).toContain("#one");
    expect(out).not.toContain("#eight");
  });

  it("enforces the 2200-char limit", async () => {
    mockedWriteCaption.mockResolvedValue("x".repeat(3000));
    const out = await buildCaption(extracted(), "en");
    expect(Array.from(out).length).toBeLessThanOrEqual(2200);
  });

  it("passes lang and cta through to Gemini", async () => {
    mockedWriteCaption.mockResolvedValue("caption");
    const ex = extracted();
    await buildCaption(ex, "ur");
    expect(mockedWriteCaption).toHaveBeenCalledWith(ex, "ur", "dm");
  });
});
