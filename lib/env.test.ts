/**
 * Phase 1 — env unit tests: defaults parse, coercions, and require* guards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv, requireFirebaseEnv, requireMetaEnv, requireQStashEnv, requireWebhookEnv, resetEnvCache } from "./env";

const SAVED = { ...process.env };

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  // Restore the ambient env (test/setup.ts dummies) after each case.
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
  resetEnvCache();
});

function clearSecrets() {
  for (const k of [
    "IG_APP_ID",
    "IG_APP_SECRET",
    "IG_VERIFY_TOKEN",
    "IG_USER_ID",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "QSTASH_TOKEN",
    "QSTASH_CURRENT_SIGNING_KEY",
    "GEMINI_API_KEY",
  ]) {
    delete process.env[k];
  }
}

describe("getEnv defaults", () => {
  it("parses behaviour defaults from plan §15", () => {
    clearSecrets();
    const env = getEnv();
    expect(env.PUBLISH_MODE).toBe("review");
    expect(env.MAX_POSTS_PER_DAY).toBe(6);
    expect(env.MIN_GAP_MINUTES).toBe(90);
    expect(env.POSTING_WINDOW_START).toBe("12:00");
    expect(env.POSTING_WINDOW_END).toBe("23:00");
    expect(env.TimeZone).toBe("Asia/Karachi");
    expect(env.MAX_LISTINGS_PER_SELLER_PER_DAY).toBe(5);
    expect(env.PHOTO_DEBOUNCE_SECONDS).toBe(25);
    expect(env.RETENTION_DAYS).toBe(30);
    expect(env.CAPTION_CTA).toBe("dm");
    expect(env.COVER_SLIDE_ENABLED).toBe(false);
    expect(env.IG_API_VERSION).toBe("v26.0");
    expect(env.GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("coerces numeric strings and parses booleans", () => {
    clearSecrets();
    process.env.MAX_POSTS_PER_DAY = "10";
    process.env.COVER_SLIDE_ENABLED = "TRUE";
    process.env.PUBLISH_MODE = "dry_run";
    const env = getEnv();
    expect(env.MAX_POSTS_PER_DAY).toBe(10);
    expect(env.COVER_SLIDE_ENABLED).toBe(true);
    expect(env.PUBLISH_MODE).toBe("dry_run");
  });

  it("never throws on missing secrets — only on malformed values", () => {
    clearSecrets();
    expect(() => getEnv()).not.toThrow();
  });

  it("throws on a malformed value", () => {
    clearSecrets();
    process.env.PUBLISH_MODE = "sometimes";
    expect(() => getEnv()).toThrow();
  });
});

describe("require* guards", () => {
  it("requireWebhookEnv throws naming the missing vars", () => {
    clearSecrets();
    expect(() => requireWebhookEnv()).toThrow(/IG_APP_SECRET.*IG_VERIFY_TOKEN|IG_VERIFY_TOKEN.*IG_APP_SECRET/);
  });

  it("requireWebhookEnv passes with the test dummies", () => {
    expect(() => requireWebhookEnv()).not.toThrow();
  });

  it("requireMetaEnv requires IG_APP_ID too", () => {
    clearSecrets();
    process.env.IG_APP_SECRET = "s";
    process.env.IG_USER_ID = "u";
    expect(() => requireMetaEnv()).toThrow(/IG_APP_ID/);
  });

  it("requireFirebaseEnv requires all three service-account fields", () => {
    clearSecrets();
    process.env.FIREBASE_PROJECT_ID = "p";
    expect(() => requireFirebaseEnv()).toThrow(/FIREBASE_CLIENT_EMAIL.*FIREBASE_PRIVATE_KEY/);
  });

  it("requireQStashEnv requires token + current signing key", () => {
    clearSecrets();
    expect(() => requireQStashEnv()).toThrow(/QSTASH_TOKEN/);
  });
});
