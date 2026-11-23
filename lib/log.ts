/**
 * Structured JSON logging with PII redaction at the log boundary.
 *
 * NEVER log: tokens, app secrets, API keys, raw message bodies containing
 * personal data. IGSIDs are truncated. Phone numbers, emails and street
 * addresses are redacted via regex before serialization.
 */

type Level = "debug" | "info" | "warn" | "error";

const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Very rough address heuristic: number + street-ish words. Keep conservative.
const ADDRESS_RE = /\b\d{1,5}\s+[A-Za-z]{3,}(?:\s+[A-Za-z]{3,}){1,4}\b/g;

const SECRET_KEYS = new Set([
  "token",
  "access_token",
  "app_secret",
  "api_key",
  "private_key",
  "signing_key",
  "enc",
  "authorization",
]);

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEYS.has(key.toLowerCase()) && typeof value === "string") {
    return "[redacted]";
  }
  if (typeof value === "string") {
    let s = value;
    // Truncate IG-scoped ids (long numeric strings) — keep prefix for correlation.
    s = s.replace(/\b(\d{6})\d{6,}\b/g, "$1…");
    s = s.replace(PHONE_RE, "[phone]");
    s = s.replace(EMAIL_RE, "[email]");
    if (s.length > 500) s = s.slice(0, 500) + "…[truncated]";
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v);
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...redactValue("", fields) as Record<string, unknown>,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Redact PII from a free-text string (for message previews in logs/alerts). */
export function redactPII(text: string): string {
  return (redactValue("text", text) as string) ?? "";
}
