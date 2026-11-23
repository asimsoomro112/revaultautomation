/**
 * Google Gemini client — Phase 2 implementation.
 *
 * Uses @google/genai with GEMINI_MODEL from env (default gemini-3.8-flash;
 * verified 2026-09-30 against ai.google.dev/gemini-api/docs/models — 3.8 Flash
 * is the current stable flagship; 3.5 Flash remains a valid stable fallback).
 * NEVER the gemini-2.5 family (retires 2026-10-16) — guarded at client creation.
 *
 * Structured output: the installed SDK (v2.x) routes raw JSON schemas through
 * `config.responseJsonSchema` (see GenerateContentConfig in the SDK .d.ts;
 * data placed in `responseSchema` is auto-moved there since v1.9.0). We pass
 * hand-authored JSON Schemas via `responseJsonSchema` + `responseMimeType:
 * "application/json"`, then validate the parsed payload with zod. Any schema
 * failure is a non-retryable GeminiError (fail closed upstream).
 */
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { ExtractedItem, Intent, Lang, ModerationResult } from "./types";
import { getEnv, requireGeminiEnv, resetEnvCache } from "./env";
import { intentPrompt, visionPrompt, LANG_NAMES } from "./prompts";
import { log } from "./log";

export interface IntentResult {
  intent: Intent;
  lang: Lang;
  confidence: number;
}

export interface VisionResult {
  extracted: ExtractedItem;
  /** Fields still missing or below the confidence threshold. */
  missing: string[];
  moderation: ModerationResult;
}

export interface GeminiClient {
  /** Classify a newly-seen conversation's intent + detect language. */
  classifyIntent(text: string, history: string[]): Promise<IntentResult>;
  /**
   * ONE multimodal call per finalize: all listing photos + accumulated chat text
   * → structured extraction + moderation verdict. Must never hallucinate
   * brand/size/price (null unless visible/stated with confidence).
   */
  extractListing(imageBuffers: Buffer[], chatText: string, lang: Lang): Promise<VisionResult>;
  /** Write the Instagram caption ONLY from verified extracted data. */
  writeCaption(extracted: ExtractedItem, lang: Lang, cta: "dm" | "site"): Promise<string>;
  /** Short conversational reply for NEEDS_INFO follow-ups / FAQ answers. */
  chatReply(prompt: string, lang: Lang): Promise<string>;
}

export class GeminiError extends Error {
  constructor(message: string, public readonly retryable: boolean = true) {
    super(message);
    this.name = "GeminiError";
  }
}

// ---------------------------------------------------------------------------
// zod schemas (validate what the model returns)
// ---------------------------------------------------------------------------

const intentZod = z.object({
  intent: z.enum(["SELLER_SUBMIT", "BUYER_QUESTION", "OTHER"]),
  lang: z.enum(["ur", "roman", "en"]),
  confidence: z.number().min(0).max(1),
});

const conditionZod = z.enum(["new", "like_new", "good", "fair"]);

const extractedZod = z.object({
  title: z.string().min(1).max(300),
  category: z.string().nullable(),
  gender: z.string().nullable(),
  brand: z.string().nullable(),
  color: z.string().nullable(),
  size: z.string().nullable(),
  condition: conditionZod.nullable(),
  price_pkr: z.number().nullable(),
  city: z.string().nullable(),
  defects: z.array(z.string()).default([]),
  measurements: z.string().nullable(),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
});

const perImageZod = z.object({
  photo_index: z.number().int().min(0),
  is_clothing: z.boolean(),
  nudity_sexual: z.boolean(),
  visible_faces: z.boolean(),
  minors: z.boolean(),
  offensive_text: z.boolean(),
  contact_info: z.boolean(),
  stock_or_stolen_suspicion: z.boolean(),
});

const moderationZod = z.object({
  verdict: z.enum(["PASS", "REVIEW", "FAIL"]),
  reasons: z.array(z.string()).default([]),
  counterfeit_claim: z.boolean().default(false),
  text_contact_info: z.boolean().default(false),
  per_image: z.array(perImageZod).default([]),
});

const visionZod = z.object({
  extracted: extractedZod,
  missing: z.array(z.string()).default([]),
  moderation: moderationZod,
});

// ---------------------------------------------------------------------------
// JSON Schemas sent to the API (responseJsonSchema). Nullable fields use
// `nullable: true` (OpenAPI 3.0 subset the backend understands). The
// confidence map uses a FIXED key set — the subset does not reliably support
// additionalProperties.
// ---------------------------------------------------------------------------

const CONFIDENCE_KEYS = [
  "title",
  "category",
  "gender",
  "brand",
  "color",
  "size",
  "condition",
  "price_pkr",
  "city",
  "defects",
  "measurements",
];

const confidenceJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: Object.fromEntries(CONFIDENCE_KEYS.map((k) => [k, { type: "number", nullable: true }])),
};

const intentJsonSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["SELLER_SUBMIT", "BUYER_QUESTION", "OTHER"] },
    lang: { type: "string", enum: ["ur", "roman", "en"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["intent", "lang", "confidence"],
} as const;

const visionJsonSchema = {
  type: "object",
  properties: {
    extracted: {
      type: "object",
      properties: {
        title: { type: "string" },
        category: { type: "string", nullable: true },
        gender: { type: "string", nullable: true },
        brand: { type: "string", nullable: true },
        color: { type: "string", nullable: true },
        size: { type: "string", nullable: true },
        condition: { type: "string", enum: ["new", "like_new", "good", "fair"], nullable: true },
        price_pkr: { type: "number", nullable: true },
        city: { type: "string", nullable: true },
        defects: { type: "array", items: { type: "string" } },
        measurements: { type: "string", nullable: true },
        confidence: confidenceJsonSchema,
      },
      required: ["title", "category", "gender", "brand", "color", "size", "condition", "price_pkr", "city", "defects", "measurements", "confidence"],
    },
    missing: { type: "array", items: { type: "string" } },
    moderation: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "REVIEW", "FAIL"] },
        reasons: { type: "array", items: { type: "string" } },
        counterfeit_claim: { type: "boolean" },
        text_contact_info: { type: "boolean" },
        per_image: {
          type: "array",
          items: {
            type: "object",
            properties: {
              photo_index: { type: "integer" },
              is_clothing: { type: "boolean" },
              nudity_sexual: { type: "boolean" },
              visible_faces: { type: "boolean" },
              minors: { type: "boolean" },
              offensive_text: { type: "boolean" },
              contact_info: { type: "boolean" },
              stock_or_stolen_suspicion: { type: "boolean" },
            },
            required: ["photo_index", "is_clothing", "nudity_sexual", "visible_faces", "minors", "offensive_text", "contact_info", "stock_or_stolen_suspicion"],
          },
        },
      },
      required: ["verdict", "reasons", "counterfeit_claim", "text_contact_info", "per_image"],
    },
  },
  required: ["extracted", "missing", "moderation"],
} as const;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function resolveModel(): string {
  const model = getEnv().GEMINI_MODEL;
  if (model.startsWith("gemini-2.5")) {
    throw new Error(
      `Refusing to use retired model family: GEMINI_MODEL=${model} (gemini-2.5 retires 2026-10-16). Set GEMINI_MODEL to a supported model, e.g. gemini-3.8-flash.`,
    );
  }
  return model;
}

/** Map unknown SDK/network errors to GeminiError with a retryable flag. */
export function classifyGeminiError(err: unknown, context: string): GeminiError {
  if (err instanceof GeminiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Retryable: rate limits, overload, timeouts, network blips.
  const retryable =
    /429|rate.?limit|quota|503|overloaded|timeout|timed out|econnreset|enotfound|eai_again|socket|network|500|502|504/.test(lower);
  return new GeminiError(`${context}: ${msg.slice(0, 300)}`, retryable);
}

function parseJsonResponse(text: string | undefined, context: string): unknown {
  if (!text || !text.trim()) throw new GeminiError(`${context}: empty response from model`, true);
  // Tolerate markdown fences in case the model wraps the JSON anyway.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new GeminiError(`${context}: response is not valid JSON`, false);
  }
}

class GeminiClientImpl implements GeminiClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  private async structured<T>(prompt: string, schema: unknown, zodSchema: z.ZodType<T>, context: string): Promise<T> {
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature: 0.2,
        },
      });
      const json = parseJsonResponse(res.text, context);
      const parsed = zodSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new GeminiError(`${context}: schema validation failed — ${issues.slice(0, 400)}`, false);
      }
      return parsed.data;
    } catch (err) {
      throw classifyGeminiError(err, context);
    }
  }

  private async text(prompt: string, context: string, temperature = 0.7): Promise<string> {
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: { temperature, maxOutputTokens: 1024 },
      });
      const out = res.text?.trim();
      if (!out) throw new GeminiError(`${context}: empty response from model`, true);
      return out;
    } catch (err) {
      throw classifyGeminiError(err, context);
    }
  }

  async classifyIntent(text: string, history: string[]): Promise<IntentResult> {
    const result = await this.structured(intentPrompt(text, history), intentJsonSchema, intentZod, "classifyIntent");
    return { intent: result.intent, lang: result.lang, confidence: result.confidence };
  }

  async extractListing(imageBuffers: Buffer[], chatText: string, lang: Lang): Promise<VisionResult> {
    if (imageBuffers.length === 0) throw new GeminiError("extractListing: no image buffers provided", false);
    const parts: Array<Record<string, unknown>> = imageBuffers.map((buf) => ({
      inlineData: { data: buf.toString("base64"), mimeType: "image/jpeg" },
    }));
    parts.push({ text: visionPrompt(chatText, lang) });
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: parts as never,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: visionJsonSchema,
          temperature: 0.1,
        },
      });
      const json = parseJsonResponse(res.text, "extractListing");
      const parsed = visionZod.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new GeminiError(`extractListing: schema validation failed — ${issues.slice(0, 400)}`, false);
      }
      const { extracted, missing, moderation } = parsed.data;
      return {
        extracted: { ...extracted, confidence: { ...extracted.confidence } } as ExtractedItem,
        missing,
        moderation: moderation as ModerationResult,
      };
    } catch (err) {
      throw classifyGeminiError(err, "extractListing");
    }
  }

  async writeCaption(extracted: ExtractedItem, lang: Lang, cta: "dm" | "site"): Promise<string> {
    const ctaLine = cta === "site" ? "Shop: revaultx.vercel.app" : "DM to buy 🤍";
    const defectsLine =
      extracted.defects.length > 0 ? `Honest defects: ${extracted.defects.join(", ")}` : "No visible defects stated";
    const prompt = `Write an Instagram caption for a preloved fashion listing. Language: ${LANG_NAMES[lang]} (match that language; keep hashtags in English).

Listing facts (ONLY use these — never invent anything):
- Title: ${extracted.title}
- Category: ${extracted.category ?? "—"}
- Size: ${extracted.size ?? "—"}
- Condition: ${extracted.condition ?? "—"}
- Price: ${extracted.price_pkr != null ? `Rs ${extracted.price_pkr}` : "—"}
- City: ${extracted.city ?? "—"}
- Brand: ${extracted.brand ?? "(not stated — do NOT mention a brand)"}
- Color: ${extracted.color ?? "—"}
- ${defectsLine}

Structure: hook line, key details, defects line, CTA line ("${ctaLine}"), then 3-5 relevant hashtags like #prelovedpakistan.
Max 2200 chars. No seller personal info. Output ONLY the caption.`;
    return this.text(prompt, "writeCaption", 0.8);
  }

  async chatReply(prompt: string, lang: Lang): Promise<string> {
    const full = `${prompt}\n\nReply in ${LANG_NAMES[lang]}. Keep it short (1-2 sentences), warm, casual. No hashtags.`;
    return this.text(full, "chatReply", 0.7);
  }
}

let cachedClient: GeminiClient | null = null;

/** Singleton. Reads GEMINI_API_KEY + GEMINI_MODEL from env; guards the 2.5 family. */
export function getGeminiClient(): GeminiClient {
  if (!cachedClient) {
    const env = requireGeminiEnv();
    const model = resolveModel();
    log.info("Gemini client initialized", { model });
    cachedClient = new GeminiClientImpl(env.GEMINI_API_KEY as string, model);
  }
  return cachedClient;
}

export type { ExtractedItem, Intent, Lang, ModerationResult };

/** Test-only helpers: prompt/schema inspection + singleton reset. */
export const __testing__ = {
  resetClient: () => {
    cachedClient = null;
    resetEnvCache();
  },
  resolveModel,
  classifyGeminiError,
  intentJsonSchema,
  visionJsonSchema,
  intentZod,
  visionZod,
};
