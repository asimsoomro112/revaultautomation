/**
 * Phase 2 — pure conversation-engine helpers (no Firebase, no network).
 */
import { describe, expect, it } from "vitest";
import { blankListingDoc } from "./db";
import {
  applyFieldValue,
  blankExtracted,
  canTransition,
  coerceFieldValue,
  detectLang,
  isHumanKeyword,
  isWithinWindow,
  mapCondition,
  mapGender,
  matchTypedAnswer,
  nextQuestion,
  parseQuickReplyPayload,
  readyForConfirm,
  setConversationState,
  SPAM_MAX_PER_HOUR,
} from "./conversation";
import { blankTestConversation, fullTestExtracted, makePhoto } from "./test-fakes";
import type { ListingDoc } from "./types";

describe("canTransition", () => {
  it("allows the happy path IDLE→COLLECTING→NEEDS_INFO→CONFIRM→IDLE", () => {
    expect(canTransition("IDLE", "COLLECTING")).toBe(true);
    expect(canTransition("COLLECTING", "NEEDS_INFO")).toBe(true);
    expect(canTransition("NEEDS_INFO", "CONFIRM")).toBe(true);
    expect(canTransition("CONFIRM", "IDLE")).toBe(true);
  });
  it("allows staying in place", () => {
    for (const s of ["IDLE", "COLLECTING", "NEEDS_INFO", "CONFIRM"] as const) {
      expect(canTransition(s, s)).toBe(true);
    }
  });
  it("rejects regressions (CONFIRM→COLLECTING, NEEDS_INFO→COLLECTING, *→skips)", () => {
    expect(canTransition("CONFIRM", "COLLECTING")).toBe(false);
    expect(canTransition("CONFIRM", "NEEDS_INFO")).toBe(true); // edit loop is legal
    expect(canTransition("NEEDS_INFO", "COLLECTING")).toBe(false);
    expect(canTransition("IDLE", "CONFIRM")).toBe(false);
    expect(canTransition("IDLE", "NEEDS_INFO")).toBe(false);
  });
});

describe("setConversationState", () => {
  it("sets state on legal transitions and refuses illegal ones", () => {
    const convo = blankTestConversation();
    expect(setConversationState(convo, "COLLECTING")).toBe(true);
    expect(convo.state).toBe("COLLECTING");
    expect(setConversationState(convo, "IDLE")).toBe(true); // cancel path
    expect(setConversationState(convo, "CONFIRM")).toBe(false); // illegal from IDLE
    expect(convo.state).toBe("IDLE");
  });
});

describe("detectLang", () => {
  it("detects Urdu script", () => {
    expect(detectLang(["السلام علیکم"])).toBe("ur");
  });
  it("detects Roman Urdu markers", () => {
    expect(detectLang(["salam, mujhe ye shirt bechni hai"])).toBe("roman");
    expect(detectLang(["price kya hai?"])).toBe("roman");
  });
  it("detects English", () => {
    expect(detectLang(["Hello, how are you doing today?"])).toBe("en");
  });
  it("defaults to roman on empty input", () => {
    expect(detectLang([])).toBe("roman");
    expect(detectLang(["   "])).toBe("roman");
  });
});

describe("isHumanKeyword", () => {
  it("matches English + Roman-Urdu variants", () => {
    expect(isHumanKeyword("can I talk to a human?")).toBe(true);
    expect(isHumanKeyword("koi insan hai?")).toBe(true);
    expect(isHumanKeyword("real person se baat karni hai")).toBe(true);
  });
  it("does not match ordinary chatter", () => {
    expect(isHumanKeyword("ye shirt kitne ki hai?")).toBe(false);
    expect(isHumanKeyword("humanity is nice")).toBe(false);
  });
});

describe("parseQuickReplyPayload", () => {
  it("parses all four payload kinds", () => {
    expect(parseQuickReplyPayload("consent:post")).toEqual({ action: "consent.post" });
    expect(parseQuickReplyPayload("consent:edit")).toEqual({ action: "consent.edit" });
    expect(parseQuickReplyPayload("consent:cancel")).toEqual({ action: "consent.cancel" });
    expect(parseQuickReplyPayload("info:condition:like_new")).toEqual({
      action: "info.answer",
      value: "condition:like_new",
    });
  });
  it("returns null for unknown payloads", () => {
    expect(parseQuickReplyPayload("nope")).toBeNull();
    expect(parseQuickReplyPayload("info:")).toBeNull();
  });
});

describe("isWithinWindow", () => {
  const NOW = Date.parse("2026-09-30T17:05:00.000Z");
  it("true 1h after the last user message", () => {
    expect(isWithinWindow("2026-09-30T16:05:00.000Z", NOW)).toBe(true);
  });
  it("false when never heard from the user (null)", () => {
    expect(isWithinWindow(null, NOW)).toBe(false);
  });
  it("false at exactly 24h (boundary closed)", () => {
    expect(isWithinWindow("2026-09-29T17:05:00.000Z", NOW)).toBe(false);
  });
  it("false on garbage timestamps", () => {
    expect(isWithinWindow("not-a-date", NOW)).toBe(false);
  });
});

describe("nextQuestion", () => {
  it("prioritizes photos > category > condition > size > price_pkr > city", () => {
    expect(nextQuestion(["city", "price_pkr", "photos", "size"], "roman").field).toBe("photos");
    expect(nextQuestion(["city", "price_pkr", "category"], "roman").field).toBe("category");
    expect(nextQuestion(["city", "condition"], "roman").field).toBe("condition");
    expect(nextQuestion(["city"], "roman").field).toBe("city");
  });
  it("gives quick replies for enum fields and typed fallback for desktop", () => {
    const q = nextQuestion(["condition"], "roman");
    expect(q.quickReplies).toBeDefined();
    expect(q.quickReplies!.length).toBeGreaterThan(0);
    expect(q.question).toMatch(/likh dein|1\)/i); // typed fallback line for desktop users
  });
  it("asks a plain question for free-text fields", () => {
    const q = nextQuestion(["city"], "roman");
    expect(q.quickReplies).toBeUndefined();
    expect(q.question.length).toBeGreaterThan(5);
  });
});

function listingWith(extracted: ReturnType<typeof fullTestExtracted>, photoCount: number): ListingDoc {
  const l = blankListingDoc("lst_x", "igsid_x", "2026-09-30T17:05:00.000Z");
  l.extracted = extracted;
  l.photos = Array.from({ length: photoCount }, (_, i) => makePhoto(`sellers/x/${i}.jpg`));
  return l;
}

describe("readyForConfirm", () => {
  it("is ok when all required fields are set and ≥2 photos", () => {
    expect(readyForConfirm(listingWith(fullTestExtracted(), 2)).ok).toBe(true);
  });
  it("requires ≥2 photos", () => {
    const r = readyForConfirm(listingWith(fullTestExtracted(), 1));
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("photos");
  });
  it("lists each missing required field", () => {
    const e = fullTestExtracted();
    e.price_pkr = null;
    e.city = null;
    const r = readyForConfirm(listingWith(e, 3));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["price_pkr", "city"]));
  });
});

describe("coerceFieldValue", () => {
  it("parses PKR prices with separators and words", () => {
    expect(coerceFieldValue("price_pkr", "Rs 2,500")).toEqual({ ok: true, value: 2500 });
    expect(coerceFieldValue("price_pkr", "2500")).toEqual({ ok: true, value: 2500 });
    expect(coerceFieldValue("price_pkr", "free")).toEqual({ ok: false });
    expect(coerceFieldValue("price_pkr", "-5")).toEqual({ ok: false });
  });
  it("maps condition aliases", () => {
    expect(mapCondition("like new")).toBe("like_new");
    expect(mapCondition("10/10 condition")).toBe("like_new");
    expect(mapCondition("used, good")).toBe("good");
    expect(mapCondition("???")).toBeNull();
  });
  it("maps gender", () => {
    expect(mapGender("women")).toBe("women");
    expect(mapGender("larkon wala")).toBe("men");
    expect(mapGender("???")).toBeNull();
  });
  it("rejects empty input", () => {
    expect(coerceFieldValue("city", "   ")).toEqual({ ok: false });
  });
});

describe("matchTypedAnswer", () => {
  const options = [
    { title: "Like new", payload: "info:condition:like_new" },
    { title: "Good", payload: "info:condition:good" },
  ];
  it("matches by number", () => {
    expect(matchTypedAnswer("1", options)).toBe("like_new");
    expect(matchTypedAnswer("2", options)).toBe("good");
  });
  it("matches by title text", () => {
    expect(matchTypedAnswer("good", options)).toBe("good");
  });
  it("returns null when nothing matches", () => {
    expect(matchTypedAnswer("maybe", options)).toBeNull();
  });
});

describe("applyFieldValue", () => {
  it("applies values and stamps confidence 1.0", () => {
    const l: ListingDoc = blankListingDoc("lst_x", "igsid_x", "2026-09-30T17:05:00.000Z");
    applyFieldValue(l, "price_pkr", 2500);
    expect(l.extracted!.price_pkr).toBe(2500);
    expect(l.extracted!.confidence["price_pkr"]).toBe(1.0);
    applyFieldValue(l, "condition", "good");
    expect(l.extracted!.condition).toBe("good");
  });
  it("creates extracted when missing", () => {
    const l: ListingDoc = blankListingDoc("lst_x", "igsid_x", "2026-09-30T17:05:00.000Z");
    l.extracted = null;
    applyFieldValue(l, "city", "Lahore");
    expect(l.extracted!.city).toBe("Lahore");
  });
  it("blankExtracted has every field null/empty", () => {
    const e = blankExtracted();
    expect(e.category).toBeNull();
    expect(e.price_pkr).toBeNull();
    expect(e.defects).toEqual([]);
  });
});

describe("SPAM_MAX_PER_HOUR", () => {
  it("is 12 per the plan", () => {
    expect(SPAM_MAX_PER_HOUR).toBe(12);
  });
});
