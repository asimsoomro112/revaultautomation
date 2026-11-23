/**
 * POST /api/workers/ingest — QStash worker: first async hop after the webhook.
 *
 * Verifies the QStash signature over the raw body, zod-parses the
 * WorkerPayload, and delegates to processIngest (lib/ingest.ts) with the real
 * db/storage/qstash dependencies. 401 on bad signature, 400 on bad payload,
 * 500 on internal failure (→ QStash retries with backoff; processIngest is
 * idempotent per listing/photo).
 */
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import {
  blankListingDoc,
  createListing,
  getListing,
  getOrCreateConversation,
  newListingId,
  saveConversation,
  saveInboundMessage,
  saveListing,
} from "@/lib/db";
import { downloadImageToStorage } from "@/lib/storage";
import { enqueueWorker, verifyQStashSignatureRaw } from "@/lib/qstash";
import { processIngest, WorkerPayloadSchema } from "@/lib/ingest";

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
    log.warn("ingest worker: invalid qstash signature");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = WorkerPayloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.kind !== "ingest") {
    log.warn("ingest worker: bad payload", {
      issues: !parsed.success ? parsed.error.issues.map((i) => i.message).join("; ") : "wrong kind",
    });
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
  }

  try {
    const result = await processIngest(parsed.data, {
      downloadImage: downloadImageToStorage,
      getOrCreateConversation,
      saveConversation,
      getListing,
      createListing,
      saveListing,
      blankListingDoc,
      newListingId,
      enqueue: (route, payload, opts) => enqueueWorker(route, payload, opts),
      getPhotoDebounceSeconds: () => getEnv().PHOTO_DEBOUNCE_SECONDS,
      saveInbound: saveInboundMessage,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("ingest worker failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
