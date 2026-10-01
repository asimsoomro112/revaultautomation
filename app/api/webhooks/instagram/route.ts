/**
 * POST /api/webhooks/instagram — Meta Instagram webhook endpoint.
 *
 * GET: subscription verification handshake (hub.mode / hub.verify_token /
 *      hub.challenge) → 200 with the raw challenge, else 403.
 * POST:
 *   1. Read the RAW body bytes first (arrayBuffer before any JSON parse —
 *      re-serialising breaks the HMAC).
 *   2. Verify X-Hub-Signature-256 (timing-safe). Fail → 401 + log, no PII.
 *   3. Parse + flatten entry[].messaging[] into NormalizedInbound[].
 *   4. Per message: skip echoes; enqueue the ingest worker (deduplicationId =
 *      mid, so QStash itself suppresses duplicate deliveries); claim the mid
 *      in processed_webhooks (transaction → concurrent deliveries dedupe).
 *   5. Return 200 {ok:true} fast (target <800ms). Internal errors → 500 so
 *      Meta retries; the claim/enqueue pair is idempotent on redelivery.
 *
 * Ordering note (deliberate): enqueue happens BEFORE the Firestore claim.
 * If we claimed first and the enqueue then failed, the 500 → Meta retry path
 * would find the mid already claimed and drop the message. Enqueue-first with
 * deduplicationId is strictly safer: a crash between the two steps is healed
 * by redelivery, and duplicates are suppressed by both the dedup id and the
 * transaction.
 */
import { NextResponse } from "next/server";
import { requireWebhookEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { claimWebhookMid } from "@/lib/db";
import { enqueueWorker } from "@/lib/qstash";
import { parseWebhookPayload, verifyGetChallenge, verifySignature } from "@/lib/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  let verifyToken: string;
  try {
    verifyToken = requireWebhookEnv().IG_VERIFY_TOKEN as string;
  } catch (err) {
    log.error("webhook GET: webhook env not configured", { error: err instanceof Error ? err.message : String(err) });
    return new NextResponse("forbidden", { status: 403 });
  }
  const challenge = verifyGetChallenge(new URL(req.url).searchParams, verifyToken);
  if (!challenge) {
    log.warn("webhook GET: verification failed");
    return new NextResponse("forbidden", { status: 403 });
  }
  log.info("webhook GET: subscription verified");
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: Request): Promise<Response> {
  let appSecret: string;
  try {
    appSecret = requireWebhookEnv().IG_APP_SECRET as string;
  } catch (err) {
    log.error("webhook POST: webhook env not configured", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  // Raw bytes BEFORE parsing — this is what the HMAC covers.
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    log.warn("webhook POST: invalid signature");
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    log.warn("webhook POST: invalid JSON");
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const messages = parseWebhookPayload(json);

  try {
    await Promise.all(
      messages.map(async (message) => {
        if (message.kind === "echo") return;
        // Enqueue first (see ordering note above), then claim the mid.
        await enqueueWorker("ingest", { kind: "ingest", message }, { deduplicationId: message.mid });
        await claimWebhookMid(message.mid);
      }),
    );
  } catch (err) {
    // 500 → Meta retries with backoff. Claim/enqueue are idempotent, so a
    // redelivery is safe (deduplicationId + transaction).
    log.error("webhook POST: ingest dispatch failed", {
      error: err instanceof Error ? err.message : String(err),
      count: messages.length,
    });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, received: messages.length });
}
