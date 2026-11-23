/**
 * Phase 2 — prompt contract tests: the safety-critical instructions that must
 * survive future prompt edits (anti-hallucination, consent public-warning).
 */
import { describe, expect, it } from "vitest";
import {
  consentQuickReplies,
  consentText,
  intentPrompt,
  questionForField,
  visionPrompt,
} from "./prompts";

describe("visionPrompt (anti-hallucination)", () => {
  it("forbids inventing brand/size/price and requires null when not visible", () => {
    const p = visionPrompt("some chat", "roman");
    expect(p).toMatch(/never invent|do not invent|hallucinat/i);
    expect(p).toMatch(/null/);
  });
  it("demands per-field confidence and a missing[] list", () => {
    const p = visionPrompt("", "roman");
    expect(p).toMatch(/confidence/i);
    expect(p).toMatch(/missing/);
  });
  it("requires per-image moderation flags", () => {
    const p = visionPrompt("", "roman");
    expect(p).toMatch(/per_image|per-image/i);
  });
});

describe("consentText", () => {
  it("warns the post is PUBLIC and the bot cannot delete it", () => {
    for (const lang of ["roman", "ur", "en"] as const) {
      const t = consentText(lang);
      expect(t.length).toBeGreaterThan(20);
    }
    const t = consentText("roman");
    expect(t).toMatch(/public/i);
  });
  it("mentions removal goes through the admin", () => {
    expect(consentText("roman")).toMatch(/admin|message us|DM/i);
  });
});

describe("consentQuickReplies", () => {
  it("emits the three consent payloads", () => {
    const payloads = consentQuickReplies().map((q) => q.payload);
    expect(payloads).toEqual(
      expect.arrayContaining(["consent:post", "consent:edit", "consent:cancel"]),
    );
  });
  it("keeps titles within Instagram's 20-char quick-reply limit", () => {
    for (const q of consentQuickReplies()) {
      expect(q.title.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("intentPrompt", () => {
  it("defines the three intent classes", () => {
    const p = intentPrompt("hello", []);
    expect(p).toMatch(/SELLER_SUBMIT/);
    expect(p).toMatch(/BUYER_QUESTION/);
    expect(p).toMatch(/OTHER/);
  });
});

describe("questionForField", () => {
  it("caps enum quick replies at 13 and titles at 20 chars", () => {
    for (const field of ["condition", "category", "gender"] as const) {
      const q = questionForField(field, "roman");
      expect(q.quickReplies!.length).toBeLessThanOrEqual(13);
      for (const o of q.quickReplies!) {
        expect(o.title.length).toBeLessThanOrEqual(20);
      }
    }
  });
});
