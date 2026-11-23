/**
 * Phase 2 — Gemini client tests with a mocked @google/genai SDK
 * (no network, no API key).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    models = { generateContent };
    constructor(_opts: unknown) {
      // test double — ignores credentials
    }
  }
  return { GoogleGenAI };
});

import { GeminiError, __testing__, getGeminiClient } from "./gemini";

const { classifyGeminiError, resetClient, resolveModel, setExtractRetryDelays } = __testing__;

function jsonReply(obj: unknown) {
  generateContent.mockResolvedValueOnce({ text: JSON.stringify(obj) });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  process.env.GEMINI_API_KEY = "test_key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
});

describe("resolveModel guard", () => {
  it("throws on the retired gemini-2.5 family", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    expect(() => resolveModel()).toThrow(/retired/i);
  });
  it("accepts gemini-3.5-flash", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash";
    expect(resolveModel()).toBe("gemini-3.5-flash");
  });
});

describe("classifyGeminiError", () => {
  it("marks rate limits / 5xx / timeouts retryable", () => {
    expect(classifyGeminiError(new Error("429 rate limit exceeded"), "x").retryable).toBe(true);
    expect(classifyGeminiError(new Error("503 overloaded"), "x").retryable).toBe(true);
    expect(classifyGeminiError(new Error("socket hang up"), "x").retryable).toBe(true);
  });
  it("marks auth / programming errors non-retryable", () => {
    expect(classifyGeminiError(new Error("401 invalid api key"), "x").retryable).toBe(false);
  });
  it("passes GeminiError through unchanged", () => {
    const g = new GeminiError("x", false);
    expect(classifyGeminiError(g, "y")).toBe(g);
  });
});

describe("getGeminiClient.classifyIntent", () => {
  it("returns the parsed intent", async () => {
    jsonReply({ intent: "SELLER_SUBMIT", confidence: 0.92, lang: "roman" });
    const client = getGeminiClient();
    const res = await client.classifyIntent("mujhe shirt bechni hai", []);
    expect(res.intent).toBe("SELLER_SUBMIT");
    expect(res.confidence).toBeCloseTo(0.92);
  });
  it("bad JSON → GeminiError, non-retryable", async () => {
    generateContent.mockResolvedValueOnce({ text: "not json {{{" });
    const client = getGeminiClient();
    const err = await client.classifyIntent("hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(false);
  });
  it("schema-invalid JSON → GeminiError, non-retryable", async () => {
    jsonReply({ intent: "NOPE", confidence: 2.5, lang: "xx" });
    const client = getGeminiClient();
    const err = await client.classifyIntent("hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(false);
  });
  it("network failure → GeminiError, retryable", async () => {
    generateContent.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));
    const client = getGeminiClient();
    const err = await client.classifyIntent("hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(true);
  });
});

describe("getGeminiClient.extractListing", () => {
  const visionJson = {
    extracted: {
      title: "Zara blazer",
      category: "blazer",
      gender: "women",
      brand: null,
      color: "black",
      size: "M",
      condition: "like_new",
      price_pkr: 2500,
      city: "Karachi",
      defects: [],
      measurements: null,
      confidence: { category: 0.9 },
    },
    missing: ["caption"],
    moderation: {
      verdict: "PASS",
      reasons: [],
      counterfeit_claim: false,
      text_contact_info: false,
      per_image: [],
    },
  };
  it("returns extracted + missing + moderation", async () => {
    jsonReply(visionJson);
    const client = getGeminiClient();
    const res = await client.extractListing([Buffer.from("img")], "chat text", "roman");
    expect(res.extracted.category).toBe("blazer");
    expect(res.missing).toEqual(["caption"]);
    expect(generateContent).toHaveBeenCalledOnce();
    const call = generateContent.mock.calls[0]![0];
    // Multimodal: images ride along as inlineData parts.
    expect(JSON.stringify(call)).toMatch(/inlineData/);
  });
  it("retries a transient 503 once, then succeeds", async () => {
    setExtractRetryDelays([0, 0]);
    generateContent.mockRejectedValueOnce(
      new Error(
        '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
      ),
    );
    jsonReply(visionJson);
    const client = getGeminiClient();
    const res = await client.extractListing([Buffer.from("img")], "chat text", "roman");
    expect(res.extracted.category).toBe("blazer");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
  it("gives up after the retries are exhausted — still a retryable GeminiError", async () => {
    setExtractRetryDelays([0, 0]);
    generateContent.mockRejectedValue(new Error("503 overloaded"));
    const client = getGeminiClient();
    const err = await client.extractListing([Buffer.from("img")], "chat text", "roman").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(true);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });
  it("does NOT retry a non-retryable error (401)", async () => {
    setExtractRetryDelays([0, 0]);
    generateContent.mockRejectedValueOnce(new Error("401 invalid api key"));
    const client = getGeminiClient();
    const err = await client.extractListing([Buffer.from("img")], "chat text", "roman").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(false);
    expect(generateContent).toHaveBeenCalledOnce();
  });
});
