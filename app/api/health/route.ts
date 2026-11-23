/**
 * GET /api/health — liveness + dependency presence.
 *
 * MUST NEVER throw when env is missing: every check degrades to
 * 'unconfigured'/'missing' instead of raising. The only Firestore read
 * (admin_settings for the IG token) is skipped entirely when Firebase env is
 * absent and is wrapped in try/catch.
 */
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getAdminSettings } from "@/lib/db";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function firebaseConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

export async function GET(): Promise<Response> {
  try {
    const env = getEnv();
    let igToken: "configured" | "missing" = "missing";
    if (firebaseConfigured()) {
      try {
        const settings = await getAdminSettings();
        igToken = settings.token ? "configured" : "missing";
      } catch {
        igToken = "missing";
      }
    }
    return NextResponse.json({
      ok: true,
      version: pkg.version,
      ts: new Date().toISOString(),
      checks: {
        firestore: firebaseConfigured() ? "ok" : "unconfigured",
        qstash: env.QSTASH_TOKEN ? "ok" : "unconfigured",
        gemini: env.GEMINI_API_KEY ? "configured" : "missing",
        ig_token: igToken,
        publish_mode: env.PUBLISH_MODE,
        ig_api_version: env.IG_API_VERSION,
      },
    });
  } catch {
    // Absolute last resort — health must always answer.
    return NextResponse.json({ ok: false, ts: new Date().toISOString() }, { status: 500 });
  }
}
