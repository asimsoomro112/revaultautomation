/**
 * Phase 2 — Gemini client tests with a mocked @google/genai SDK
 * (no network, no API key).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const listModels = vi.fn();

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    models = { generateContent, list: listModels };
    constructor(_opts: unknown) {
      // test double — ignores credentials
    }
  }
  return { GoogleGenAI };
});

import { GeminiError, __testing__, getGeminiClient } from "./gemini";

const { classifyGeminiError, resetClient, resolveModel, resolveModels, setExtractRetryDelays } = __testing__;

function modelOfCall(n: number): string {
  return (generateContent.mock.calls[n]![0] as { model: string }).model;
}

function jsonReply(obj: unknown) {
  generateContent.mockResolvedValueOnce({ text: JSON.stringify(obj) });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  process.env.GEMINI_API_KEY = "test_key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  // The 2.5-fallback test below sets this; clear it so later tests see the default.
  delete process.env.GEMINI_FALLBACK_MODELS;
  // Live model list: by default every configured model is listed.
  listModels.mockResolvedValue({
    page: [
      { name: "models/gemini-3.5-flash" },
      { name: "models/gemini-3.6-flash" },
      { name: "models/gemini-3-flash-preview" },
    ],
  });
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

describe("resolveModels fallback chain", () => {
  it("primary first, then fallbacks in order", () => {
    process.env.GEMINI_MODEL = "gemini-3-flash-preview";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash, gemini-3.5-flash";
    expect(resolveModels()).toEqual(["gemini-3-flash-preview", "gemini-3.6-flash", "gemini-3.5-flash"]);
  });
  it("dedupes the primary when it also appears in fallbacks", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash,gemini-3.5-flash";
    expect(resolveModels()).toEqual(["gemini-3.5-flash", "gemini-3.6-flash"]);
  });
  it("empty fallback list → primary only", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash";
    process.env.GEMINI_FALLBACK_MODELS = "";
    expect(resolveModels()).toEqual(["gemini-3.5-flash"]);
  });
  it("throws when a fallback is the retired gemini-2.5 family", () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-2.5-flash";
    expect(() => resolveModels()).toThrow(/GEMINI_FALLBACK_MODELS/);
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

describe("live model list (ensureLiveChain)", () => {
  it("keeps the configured chain when the live list fails", async () => {
    listModels.mockRejectedValueOnce(new Error("network down"));
    jsonReply({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });
    const client = getGeminiClient();
    const res = await client.classifyIntent("mujhe shirt bechni hai", []);
    expect(res.intent).toBe("SELLER_SUBMIT");
    expect(generateContent).toHaveBeenCalledOnce();
    expect(modelOfCall(0)).toBe("gemini-3.5-flash");
  });
  it("asks the live list only once per client", async () => {
    jsonReply({ intent: "OTHER", confidence: 0.5, lang: "en" });
    jsonReply({ intent: "OTHER", confidence: 0.5, lang: "en" });
    const client = getGeminiClient();
    await client.classifyIntent("hi", []);
    await client.classifyIntent("hi", []);
    expect(listModels).toHaveBeenCalledOnce();
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
    // Persistent rejection: withFallback tries every model in the chain.
    generateContent.mockRejectedValue(new Error("fetch failed: socket hang up"));
    const client = getGeminiClient();
    const err = await client.classifyIntent("hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(true);
  });
  it("falls back to the next model when the primary 503s", async () => {
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
    generateContent.mockRejectedValueOnce(new Error("503 overloaded"));
    jsonReply({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });
    const client = getGeminiClient();
    const res = await client.classifyIntent("mujhe shirt bechni hai", []);
    expect(res.intent).toBe("SELLER_SUBMIT");
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(modelOfCall(0)).toBe("gemini-3.5-flash");
    expect(modelOfCall(1)).toBe("gemini-3.6-flash");
  });
  it("does NOT fall back on a non-retryable error", async () => {
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
    generateContent.mockRejectedValueOnce(new Error("401 invalid api key"));
    const client = getGeminiClient();
    const err = await client.classifyIntent("hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(false);
    expect(generateContent).toHaveBeenCalledOnce();
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
    // The retry budget IS the chain: a lone model gets one attempt, so the
    // retry here goes to the fallback model, not a re-hammer of the primary.
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
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
    expect(modelOfCall(1)).toBe("gemini-3.6-flash");
  });
  it("falls back to the next model when the primary 503s", async () => {
    setExtractRetryDelays([0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
    generateContent.mockRejectedValueOnce(new Error("503 overloaded"));
    jsonReply(visionJson);
    const client = getGeminiClient();
    const res = await client.extractListing([Buffer.from("img")], "chat text", "roman");
    expect(res.extracted.category).toBe("blazer");
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(modelOfCall(0)).toBe("gemini-3.5-flash");
    expect(modelOfCall(1)).toBe("gemini-3.6-flash");
  });
  it("tries each model in the chain exactly once when every attempt fails", async () => {
    setExtractRetryDelays([0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
    generateContent.mockRejectedValue(new Error("503 overloaded"));
    const client = getGeminiClient();
    const err = await client.extractListing([Buffer.from("img")], "chat text", "roman").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(true);
    // 2-model chain → 2 attempts; the old fixed 3-attempt budget repeated
    // the primary as a 3rd call.
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect([modelOfCall(0), modelOfCall(1)]).toEqual([
      "gemini-3.5-flash",
      "gemini-3.6-flash",
    ]);
  });
  it("tries a 4th fallback model when the chain has 4 models", async () => {
    // 4 delays: the OLD budget was delays.length + 1, so [0,0,0] would have
    // accidentally let the old code reach the 4th model too. With 4 delays
    // the old code makes 5 calls (rotating back to the primary); the new
    // budget is the chain, so exactly 4.
    setExtractRetryDelays([0, 0, 0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash,gemini-3-flash-preview,gemini-3.2-flash";
    listModels.mockResolvedValue({
      page: [
        { name: "models/gemini-3.5-flash" },
        { name: "models/gemini-3.6-flash" },
        { name: "models/gemini-3-flash-preview" },
        { name: "models/gemini-3.2-flash" },
      ],
    });
    generateContent.mockRejectedValue(new Error("503 overloaded"));
    const client = getGeminiClient();
    const err = await client.extractListing([Buffer.from("img")], "chat text", "roman").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(generateContent).toHaveBeenCalledTimes(4);
    expect([modelOfCall(0), modelOfCall(1), modelOfCall(2), modelOfCall(3)]).toEqual([
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3-flash-preview",
      "gemini-3.2-flash",
    ]);
  });
  it("a lone model gets exactly one attempt (no re-hammer)", async () => {
    setExtractRetryDelays([0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = ""; // empty → chain is just the primary
    generateContent.mockRejectedValue(new Error("503 overloaded"));
    const client = getGeminiClient();
    const err = await client.extractListing([Buffer.from("img")], "chat text", "roman").catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.retryable).toBe(true);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it("gives up after the retries are exhausted — still a retryable GeminiError", async () => {
    setExtractRetryDelays([0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash,gemini-3-flash-preview";
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
  it("drops a configured model the live list no longer has", async () => {
    setExtractRetryDelays([0, 0]);
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";
    // Primary retired: the live list has only the fallback.
    listModels.mockResolvedValueOnce({ page: [{ name: "models/gemini-3.6-flash" }] });
    jsonReply(visionJson);
    const client = getGeminiClient();
    const res = await client.extractListing([Buffer.from("img")], "chat text", "roman");
    expect(res.extracted.category).toBe("blazer");
    expect(generateContent).toHaveBeenCalledOnce();
    expect(modelOfCall(0)).toBe("gemini-3.6-flash");
  });
});
