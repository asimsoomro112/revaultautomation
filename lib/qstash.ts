/**
 * Upstash QStash client + worker plumbing (Phase 1).
 *
 * - getQStashClient: lazy singleton (requireQStashEnv).
 * - enqueueWorker: publish a signed WorkerPayload to /api/workers/<route>
 *   with optional delaySec / notBefore (unix seconds) / deduplicationId.
 * - verifyQStashSignature(req): verify the Upstash signature over the RAW
 *   body text via the Receiver (current + next signing keys for rotation).
 *   Never throws — returns false on any failure.
 */
import { Client, Receiver } from "@upstash/qstash";
import { getEnv, requireQStashEnv } from "./env";
import { log } from "./log";
import type { WorkerKind, WorkerPayload } from "./types";

let client: Client | null = null;

/** Lazy QStash client. Throws (clear error) when QStash env is missing. */
export function getQStashClient(): Client {
  if (!client) {
    const env = requireQStashEnv();
    client = new Client({ 
      token: env.QSTASH_TOKEN as string,
      ...(env.QSTASH_URL ? { baseUrl: env.QSTASH_URL } : {})
    });
  }
  return client;
}

export interface EnqueueOpts {
  /** Delay delivery by N seconds. */
  delaySec?: number;
  /** Deliver no earlier than this unix timestamp (seconds). */
  notBefore?: number;
  /** Idempotency key — QStash suppresses duplicate deliveries. */
  deduplicationId?: string;
}

function buildReceiver(): Receiver {
  const env = requireQStashEnv();
  return new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY as string,
    ...(env.QSTASH_NEXT_SIGNING_KEY ? { nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY } : {}),
  });
}

/**
 * Verify a QStash delivery from raw parts (body must be the exact raw text).
 * Exported so route handlers can read the body once and verify + parse it.
 */
export async function verifyQStashSignatureRaw(args: {
  signature: string | null;
  body: string;
  url: string;
}): Promise<boolean> {
  try {
    if (!args.signature) return false;
    const receiver = buildReceiver();
    return await receiver.verify({ signature: args.signature, body: args.body, url: args.url });
  } catch (err) {
    log.warn("qstash signature verification failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Verify an incoming worker request. Reads the raw body — call req.json()/text() on a clone or read once in the route. */
export async function verifyQStashSignature(req: Request): Promise<boolean> {
  try {
    const signature = req.headers.get("upstash-signature");
    const body = await req.text();
    return await verifyQStashSignatureRaw({ signature, body, url: req.url });
  } catch (err) {
    log.warn("qstash signature verification failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Enqueue a worker invocation. Target URL is ${APP_BASE_URL}/api/workers/<route>. */
export async function enqueueWorker(
  route: WorkerKind,
  payload: WorkerPayload,
  opts: EnqueueOpts = {},
): Promise<void> {
  const env = getEnv();
  const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/api/workers/${route}`;
  const res = await getQStashClient().publishJSON({
    url,
    body: payload,
    ...(opts.delaySec !== undefined ? { delay: opts.delaySec } : {}),
    ...(opts.notBefore !== undefined ? { notBefore: opts.notBefore } : {}),
    ...(opts.deduplicationId !== undefined ? { deduplicationId: opts.deduplicationId } : {}),
  });
  log.info("qstash enqueued", { route, messageId: res.messageId });
}
