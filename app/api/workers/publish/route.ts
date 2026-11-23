/**
 * POST /api/workers/publish — QStash-signed publish worker (Phase 4).
 * Thin wrapper: verify signature → parse payload → handlePublish.
 * Unexpected throws → 500 so QStash retries; handlePublish itself converts
 * Meta/storage failures into FAILED listings (no retry storm).
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyQStashSignatureRaw } from "@/lib/qstash";
import { defaultWorkerDeps } from "@/lib/workers/common";
import { handlePublish } from "@/lib/workers/publish";
import { log } from "@/lib/log";

const payloadSchema = z.object({
  kind: z.literal("publish"),
  listing_id: z.string().min(1),
});

export async function POST(req: Request) {
  const raw = await req.text();
  const okSig = await verifyQStashSignatureRaw({
    signature: req.headers.get("upstash-signature"),
    body: raw,
    url: req.url,
  });
  if (!okSig) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  try {
    const result = await handlePublish(parsed.data.listing_id, defaultWorkerDeps());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("publish worker crashed", {
      listing_id: parsed.data.listing_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "worker failed" }, { status: 500 });
  }
}
