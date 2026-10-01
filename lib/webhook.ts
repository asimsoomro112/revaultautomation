/**
 * Meta Instagram webhook helpers (Phase 1).
 *
 * - verifySignature: HMAC-SHA256 check of the RAW request body against the
 *   X-Hub-Signature-256 header (`sha256=<hex>`), timing-safe compare.
 *   Verification MUST happen before JSON parsing — re-serialising breaks it.
 * - verifyGetChallenge: GET handshake (hub.mode / hub.verify_token / hub.challenge).
 * - parseWebhookPayload: zod-validate Meta's {object:'instagram', entry[].messaging[]}
 *   shape into NormalizedInbound[].
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { InboundKind, NormalizedInbound } from "./types";

/** True iff header is a valid `sha256=` HMAC-SHA256 of rawBody under appSecret. */
export function verifySignature(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const PREFIX = "sha256=";
  if (!header.startsWith(PREFIX)) return false;
  const hex = header.slice(PREFIX.length);
  // 64 hex chars = 32 bytes for SHA-256. Reject anything else before comparing.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const actual = Buffer.from(hex, "hex");
  if (expected.length !== actual.length) return false; // paranoia; lengths are both 32
  return timingSafeEqual(expected, actual);
}

/**
 * GET webhook verification. Returns hub.challenge iff hub.mode === 'subscribe'
 * and hub.verify_token matches the configured token; otherwise null (→ 403).
 */
export function verifyGetChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== verifyToken) return null;
  const challenge = params.get("hub.challenge");
  return challenge && challenge.length > 0 ? challenge : null;
}

// --- Webhook payload parsing -------------------------------------------------

const attachmentSchema = z.object({
  type: z.string(),
  payload: z.object({ url: z.string().optional() }).optional(),
});

const messageSchema = z.object({
  mid: z.string(),
  text: z.string().optional(),
  is_echo: z.boolean().optional(),
  sticker_id: z.union([z.number(), z.string()]).optional(),
  quick_reply: z.object({ payload: z.string() }).optional(),
  attachments: z.array(attachmentSchema).optional(),
});

type WebhookMessage = z.infer<typeof messageSchema>;

// Malformed entries/messages must not kill the whole batch — fall back to
// undefined per element and skip them.
const messagingItemSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: messageSchema.optional(),
});

const entrySchema = z.object({
  id: z.string().optional(),
  messaging: z.array(messagingItemSchema.optional().catch(undefined)).optional(),
});

const webhookPayloadSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(entrySchema.optional().catch(undefined)).optional(),
});

const UNSUPPORTED_ATTACHMENT_TYPES = new Set(["video", "audio", "file"]);

function baseInbound(
  senderId: string,
  recipientId: string,
  timestampMs: number,
  message: WebhookMessage,
): Omit<NormalizedInbound, "kind" | "image_url" | "quick_reply_payload" | "unsupported_hint"> {
  return {
    mid: message.mid,
    sender_igsid: senderId,
    recipient_igid: recipientId,
    timestamp_ms: timestampMs,
    text: message.text ?? null,
  };
}

function inboundFromAttachment(
  senderId: string,
  recipientId: string,
  timestampMs: number,
  message: WebhookMessage,
  attachment: z.infer<typeof attachmentSchema>,
): NormalizedInbound {
  const base = baseInbound(senderId, recipientId, timestampMs, message);
  const type = attachment.type;
  if (type === "image" && attachment.payload?.url) {
    return { ...base, kind: "image", image_url: attachment.payload.url, quick_reply_payload: null, unsupported_hint: null };
  }
  if (UNSUPPORTED_ATTACHMENT_TYPES.has(type)) {
    return { ...base, kind: "unsupported", image_url: null, quick_reply_payload: null, unsupported_hint: type };
  }
  return { ...base, kind: "unknown", image_url: null, quick_reply_payload: null, unsupported_hint: null };
}

function parseMessage(
  senderId: string,
  recipientId: string,
  timestampMs: number,
  message: WebhookMessage,
): NormalizedInbound[] {
  const base = baseInbound(senderId, recipientId, timestampMs, message);

  // Our own outbound sends echoed back — never process.
  if (message.is_echo) {
    return [{ ...base, kind: "echo", image_url: null, quick_reply_payload: null, unsupported_hint: null }];
  }
  // Quick-reply tap (always arrives with the button title as text).
  if (message.quick_reply) {
    return [
      {
        ...base,
        kind: "quick_reply",
        image_url: null,
        quick_reply_payload: message.quick_reply.payload,
        unsupported_hint: null,
      },
    ];
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    return attachments.map((a) => inboundFromAttachment(senderId, recipientId, timestampMs, message, a));
  }
  // Stickers / GIFs arrive as sticker_id.
  if (message.sticker_id !== undefined) {
    return [{ ...base, kind: "unsupported", image_url: null, quick_reply_payload: null, unsupported_hint: "sticker" }];
  }
  if (message.text !== undefined && message.text.length > 0) {
    return [{ ...base, kind: "text", image_url: null, quick_reply_payload: null, unsupported_hint: null }];
  }
  return [{ ...base, kind: "unknown", image_url: null, quick_reply_payload: null, unsupported_hint: null }];
}

/**
 * Validate a Meta webhook body and flatten entry[].messaging[] into one
 * NormalizedInbound per message (one per attachment when a message carries
 * several). Returns [] for anything that isn't a valid instagram payload.
 * `echo` items are KEPT in the output — the route decides to skip them.
 */
export function parseWebhookPayload(json: unknown): NormalizedInbound[] {
  const parsed = webhookPayloadSchema.safeParse(json);
  if (!parsed.success) return [];
  const out: NormalizedInbound[] = [];
  for (const entry of parsed.data.entry ?? []) {
    if (!entry) continue;
    for (const item of entry.messaging ?? []) {
      if (!item || !item.message) continue; // e.g. read receipts, postbacks
      out.push(...parseMessage(item.sender.id, item.recipient.id, item.timestamp, item.message));
    }
  }
  return out;
}

/** Narrow a NormalizedInbound list to non-echo items (convenience for callers). */
export function nonEcho(inbounds: NormalizedInbound[]): NormalizedInbound[] {
  return inbounds.filter((m): m is NormalizedInbound & { kind: Exclude<InboundKind, "echo"> } => m.kind !== "echo");
}
