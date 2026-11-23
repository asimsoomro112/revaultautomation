/**
 * POST /api/workers/message — QStash worker: the conversation engine.
 *
 * Verifies the QStash signature over the raw body, zod-parses the
 * WorkerPayload, loads the persisted NormalizedInbound by mid (ingest saves it
 * before enqueueing), and delegates to handleMessage (lib/conversation.ts)
 * with real dependencies. 401 on bad signature, 400 on bad payload, 500 on
 * internal failure (→ QStash retries; handleMessage is idempotent per mid).
 */
import { NextResponse } from "next/server";
import { getInboundMessage } from "@/lib/db";
import { verifyQStashSignatureRaw } from "@/lib/qstash";
import { WorkerPayloadSchema } from "@/lib/ingest";
import { handleMessage } from "@/lib/conversation";
import { buildDeps } from "@/lib/server-deps";
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
    log.warn("message worker: invalid qstash signature");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = WorkerPayloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.kind !== "message") {
    log.warn("message worker: bad payload", {
      issues: !parsed.success ? parsed.error.issues.map((i) => i.message).join("; ") : "wrong kind",
    });
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });
  }
  const payload = parsed.data;

  try {
    const inbound = await getInboundMessage(payload.mid);
    if (!inbound) {
      // Ingest always persists before enqueueing; absence means a caller
      // bypassed ingest (or TTL expiry) — don't poison-retry, just skip.
      log.warn("message worker: inbound missing for mid", { mid: payload.mid });
      return NextResponse.json({ ok: true, skipped: "inbound_missing" });
    }
    await handleMessage(payload, inbound, buildDeps());
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error("message worker failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
