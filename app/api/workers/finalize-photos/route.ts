/**
 * POST /api/workers/finalize-photos — QStash worker: photo debounce timer.
 *
 * Fires PHOTO_DEBOUNCE_SECONDS after the last photo. Verifies the QStash
 * signature, zod-parses the FinalizePhotosPayload, and delegates to
 * handleFinalizePhotos (lib/finalize.ts): one Gemini vision call (extraction +
 * moderation), Phase 3 verdict, then NEEDS_INFO / CONFIRM / NEEDS_REVIEW /
 * REJECTED branching. Stale timers (last_photo_at moved on) are skipped.
 * 401 on bad signature, 400 on bad payload, 500 on internal failure.
 */
import { NextResponse } from "next/server";
import { verifyQStashSignatureRaw } from "@/lib/qstash";
import { WorkerPayloadSchema } from "@/lib/ingest";
import { handleFinalizePhotos } from "@/lib/finalize";
import { buildFinalizeDeps } from "@/lib/server-deps";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  // Read the raw body ONCE — it feeds both signature verification and parsing.
  const rawText = await req.text();
  const sigOk = await verifyQStashSignatureRaw({
    signature: req.headers.get("upstash-signature"),
    body: rawText,
    url: req.url,
  });
  if (!sigOk) {
    log.warn("finalize-photos worker: invalid qstash signature");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = WorkerPayloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.kind !== "finalize-photos") {
    log.warn("finalize-photos worker: bad payload", {
      issues: !parsed.success ? parsed.error.issues.map((i) => i.message).join("; ") : "wrong kind",
    });
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
  }

  try {
    const result = await handleFinalizePhotos(parsed.data, buildFinalizeDeps());
    return NextResponse.json(result);
  } catch (err) {
    log.error("finalize-photos worker failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
