/**
 * Caption writer — Phase 3.
 *
 * Contract (Phase 2/4 import this exactly):
 *   export async function buildCaption(extracted: ExtractedItem, lang: Lang): Promise<string>
 *
 * Flow: Gemini writes ONLY from the zod-verified `extracted` object (never raw
 * chat, never seller PII), then deterministic post-processing guarantees the
 * invariants a model alone can't be trusted with:
 *   1. CTA line present (per CAPTION_CTA env: "dm" | "site")
 *   2. 3–5 hashtags (derived fallbacks if the model under-tags; trimmed if it
 *      over-tags — Instagram allows 30, our house style is ≤ 5)
 *   3. Phone/email-like strings stripped defensively (regex)
 *   4. ≤ 2200 chars (Instagram caption limit), code-point safe
 *
 * Seller personal info never appears: Gemini is told to use only `extracted`,
 * and the defensive strip removes anything phone/email-shaped that slips in.
 */
import { getEnv } from "./env";
import { getGeminiClient } from "./gemini";
import type { ExtractedItem, Lang } from "./types";

const MAX_CAPTION_LEN = 2200;
const MAX_HASHTAGS = 5;
const MIN_HASHTAGS = 3;

const CTA_DM_LINE = "DM to buy 🤍";
const SITE_URL = "https://revaultx.vercel.app";

// Phone-ish: +92 300 1234567, 0300-1234567, 0300 123 4567 — needs ≥9 chars so
// plain prices ("Rs 5000") never match.
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

function slugifyTag(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 24);
}

/** Ensure exactly the configured CTA line exists (idempotent — no duplicates). */
function ensureCta(caption: string, cta: "dm" | "site"): string {
  if (cta === "dm") {
    return /dm\s+to\s+buy/i.test(caption) ? caption : `${caption}\n\n${CTA_DM_LINE}`;
  }
  return caption.includes(SITE_URL) ? caption : `${caption}\n\nShop: ${SITE_URL}`;
}

/**
 * Ensure 3–5 hashtags. Under-tagged → append derived ones
 * (#prelovedpakistan, #preloved{city}, #preloved{category}, …). Over-tagged →
 * keep the first 5, drop the rest (house style, plan §9).
 */
function ensureHashtags(caption: string, extracted: ExtractedItem): string {
  const tags = [...new Set(caption.match(HASHTAG_RE)?.map((t) => t.toLowerCase()) ?? [])];

  if (tags.length < MIN_HASHTAGS) {
    const existing = new Set(tags);
    const candidates: string[] = ["#prelovedpakistan"];
    const city = extracted.city ? slugifyTag(extracted.city) : "";
    if (city) candidates.push(`#preloved${city}`);
    const category = extracted.category ? slugifyTag(extracted.category) : "";
    if (category) candidates.push(`#preloved${category}`);
    candidates.push("#thriftpakistan", "#prelovedfashion", "#sustainablefashion");
    const fresh: string[] = [];
    for (const c of candidates) {
      if (existing.size + fresh.length >= MIN_HASHTAGS) break;
      if (!existing.has(c) && !fresh.includes(c)) fresh.push(c);
    }
    return fresh.length > 0 ? `${caption}\n\n${fresh.join(" ")}` : caption;
  }

  if (tags.length > MAX_HASHTAGS) {
    // Trim excess tags from the END, keeping the model's first 5.
    const keep = new Set(tags.slice(0, MAX_HASHTAGS));
    const lines = caption.split("\n").map((line) => {
      const lineTags = line.match(HASHTAG_RE) ?? [];
      let out = line;
      for (const t of lineTags) {
        if (!keep.has(t.toLowerCase())) out = out.replace(t, "").trimEnd();
      }
      return out;
    });
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return caption;
}

/** Remove phone/email-shaped strings defensively, then tidy whitespace. */
function stripContactInfo(caption: string): string {
  return caption
    .replace(EMAIL_RE, "")
    .replace(PHONE_RE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Enforce the 2200-char Instagram limit without splitting a code point. */
function capLength(caption: string): string {
  const chars = Array.from(caption);
  if (chars.length <= MAX_CAPTION_LEN) return caption;
  return chars.slice(0, MAX_CAPTION_LEN - 1).join("") + "…";
}

export async function buildCaption(extracted: ExtractedItem, lang: Lang): Promise<string> {
  const cta = getEnv().CAPTION_CTA;
  let caption = await getGeminiClient().writeCaption(extracted, lang, cta);
  caption = ensureCta(caption.trim(), cta);
  caption = ensureHashtags(caption, extracted);
  caption = stripContactInfo(caption);
  caption = capLength(caption);
  return caption.trim();
}
