/**
 * POST /api/workers/poll-container — QStash-signed container poller (Phase 4).
 * Thin wrapper: verify signature → parse payload → handlePollContainer.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyQStashSignatureRaw } from "@/lib/qstash";
import { defaultWorkerDeps } from "@/lib/workers/common";
import { handlePollContainer } from "@/lib/workers/poll-container";
import { log } from "@/lib/log";

const payloadSchema = z.object({
  kind: z.literal("poll-container"),
  listing_id: z.string().min(1),
  container_id: z.string().min(1),
  role: z.enum(["child", "parent"]),
  attempt: z.number().int().min(0),
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
    const result = await handlePollContainer(parsed.data, defaultWorkerDeps());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("poll-container worker crashed", {
      listing_id: parsed.data.listing_id,
      container_id: parsed.data.container_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "worker failed" }, { status: 500 });
  }
}
