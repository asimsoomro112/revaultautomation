/**
 * Environment configuration — zod-validated, lazy, test-friendly.
 *
 * Secrets are OPTIONAL at import time so unit tests and `next build` work
 * without real credentials. Route handlers / workers MUST call
 * `requireServerEnv()` (or the narrower `requireMetaEnv()` etc.) before
 * touching external services — it throws a clear error naming the missing var.
 */
import { z } from "zod";

const envSchema = z.object({
  // --- Meta / Instagram Platform ---
  IG_API_VERSION: z.string().default("v26.0"),
  IG_API_BASE: z.string().default("https://graph.instagram.com"),
  IG_APP_ID: z.string().optional(),
  IG_APP_SECRET: z.string().optional(),
  IG_VERIFY_TOKEN: z.string().optional(), // webhook hub.verify_token
  IG_USER_ID: z.string().optional(), // professional account IG user id

  // --- Token encryption (AES-256-GCM, 32-byte hex key) ---
  IG_TOKEN_ENC_KEY: z.string().optional(),

  // --- Gemini ---
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),

  // --- Firebase Admin SDK ---
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(), // \n-escaped in env

  // --- Upstash QStash ---
  QSTASH_URL: z.string().optional(),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),

  // --- Admin ---
  ADMIN_EMAILS: z.string().default(""),

  // --- Vercel Cron (Authorization: Bearer <CRON_SECRET>, sent automatically by Vercel) ---
  CRON_SECRET: z.string().optional(),

  // --- Firebase client SDK (public config for /admin sign-in; safe to expose) ---
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().optional(),

  // --- Cloudinary (photo storage only; Firestore stays the DB, Auth stays the login) ---
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(), // server-only; never NEXT_PUBLIC_

  // --- Telegram alerts ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  // --- App ---
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.string().default("development"),

  // --- Behaviour ---
  PUBLISH_MODE: z.enum(["review", "auto", "dry_run"]).default("review"),
  MAX_POSTS_PER_DAY: z.coerce.number().int().positive().default(6),
  MIN_GAP_MINUTES: z.coerce.number().int().positive().default(90),
  POSTING_WINDOW_START: z.string().default("12:00"),
  POSTING_WINDOW_END: z.string().default("23:00"),
  TimeZone: z.string().default("Asia/Karachi"),
  MAX_LISTINGS_PER_SELLER_PER_DAY: z.coerce.number().int().positive().default(5),
  PHOTO_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(25),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CAPTION_CTA: z.enum(["dm", "site"]).default("dm"),
  COVER_SLIDE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Parse (and cache) env. Never throws on missing secrets — only on malformed values. */
export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/** For tests: reset the cache after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}

function missing(names: (keyof Env)[]): string[] {
  const env = getEnv();
  return names.filter((n) => {
    const v = env[n];
    return v === undefined || v === null || v === "";
  });
}

/** Throw if any Meta credential is missing. Call at the top of Meta-touching code. */
export function requireMetaEnv(): Omit<Env, "IG_APP_SECRET" | "IG_USER_ID" | "IG_APP_ID"> &
  Record<"IG_APP_SECRET" | "IG_USER_ID" | "IG_APP_ID", string> {
  const m = missing(["IG_APP_ID", "IG_APP_SECRET", "IG_USER_ID"]);
  if (m.length > 0) throw new Error(`Missing required env vars for Meta API: ${m.join(", ")}`);
  return getEnv() as Omit<Env, "IG_APP_SECRET" | "IG_USER_ID" | "IG_APP_ID"> &
    Record<"IG_APP_SECRET" | "IG_USER_ID" | "IG_APP_ID", string>;
}

/** Throw if webhook verification secrets are missing. */
export function requireWebhookEnv(): Env {
  const m = missing(["IG_APP_SECRET", "IG_VERIFY_TOKEN"]);
  if (m.length > 0) throw new Error(`Missing required env vars for webhook verification: ${m.join(", ")}`);
  return getEnv();
}

/** Throw if Firebase Admin credentials are missing. */
export function requireFirebaseEnv(): Env {
  const m = missing(["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]);
  if (m.length > 0) throw new Error(`Missing required env vars for Firebase Admin: ${m.join(", ")}`);
  return getEnv();
}

/** Throw if QStash credentials are missing. */
export function requireQStashEnv(): Env {
  const m = missing(["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY"]);
  if (m.length > 0) throw new Error(`Missing required env vars for QStash: ${m.join(", ")}`);
  return getEnv();
}

/** Throw if Gemini credentials are missing. */
export function requireGeminiEnv(): Env {
  const m = missing(["GEMINI_API_KEY"]);
  if (m.length > 0) throw new Error(`Missing required env vars for Gemini: ${m.join(", ")}`);
  return getEnv();
}

/** Throw if Cloudinary credentials are missing. */
export function requireCloudinaryEnv(): Env {
  const m = missing(["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
  if (m.length > 0) throw new Error(`Missing required env vars for Cloudinary: ${m.join(", ")}`);
  return getEnv();
}

/** Throw if Telegram credentials are missing. */
export function requireTelegramEnv(): Env {
  const m = missing(["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID"]);
  if (m.length > 0) throw new Error(`Missing required env vars for Telegram: ${m.join(", ")}`);
  return getEnv();
}

/** Admin allowlist as a lowercase email set. */
export function adminEmailSet(): Set<string> {
  return new Set(
    getEnv()
      .ADMIN_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}
