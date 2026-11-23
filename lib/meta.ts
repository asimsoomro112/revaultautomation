/**
 * Meta Instagram Platform API client — IMPLEMENTED (Phase 4).
 *
 * Official API only (Instagram API with Instagram Login, host
 * graph.instagram.com). Token is read (decrypted) from Firestore
 * admin_settings.token — never from env.
 *
 * Docs re-verified 2026-09-30 (docs win):
 * - Containers: POST /{ig-user-id}/media {image_url, is_carousel_item:true}
 *   for children (NO media_type on children — "IMAGE" is not a valid value);
 *   parent {media_type:"CAROUSEL", children:"id1,id2", caption}.
 * - status_code ∈ IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED.
 *   Subcode 2207027 on status = still processing → keep polling, never
 *   recreate the container.
 * - media_publish: POST /{ig-user-id}/media_publish {creation_id} → {id}.
 * - content_publishing_limit: GET with fields=quota_usage,config →
 *   {data:[{quota_usage, config:{quota_total, quota_duration}}]} (some hosts
 *   return the object unwrapped — both shapes are parsed). quota_total is
 *   NEVER hardcoded (Meta is mid-transition 50 → 100).
 * - Messaging: POST /me/messages {recipient:{id}, messaging_type:"RESPONSE",
 *   message:{text?, attachment?, quick_replies:[{content_type:"text",…}]}}.
 * - Token endpoints (lib/tokens.ts) are UNVERSIONED on graph.instagram.com.
 */
import type { Condition } from "./types";
import { getEnv, requireMetaEnv } from "./env";
import { decryptToken } from "./ig-token";
import { getAdminSettings } from "./db";
import { log } from "./log";

export interface QuickReply {
  /** ≤ 20 chars, plain text (Meta truncates beyond 20). */
  title: string;
  payload: string;
}

export interface SendMessageOpts {
  text?: string;
  /** Public HTTPS image URL for image messages. */
  imageUrl?: string;
  quickReplies?: QuickReply[];
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED";

export interface MetaClient {
  /** Send a DM within the 24h window. Throws MetaApiError on failure. */
  sendMessage(igsid: string, opts: SendMessageOpts): Promise<{ messageId: string }>;
  /** Create an image container; isCarouselItem=true for carousel children (no caption). */
  createImageContainer(imageUrl: string, opts?: { isCarouselItem?: boolean; caption?: string }): Promise<string>;
  /** Create the CAROUSEL parent container. */
  createCarouselContainer(children: string[], caption: string): Promise<string>;
  /** Poll container processing status. */
  getContainerStatus(containerId: string): Promise<ContainerStatus>;
  /** Publish a FINISHED container → media id. */
  publishContainer(containerId: string): Promise<string>;
  /** Fetch the public permalink of a published media id. */
  getPermalink(mediaId: string): Promise<string>;
  /** Read live quota: GET /{ig-user-id}/content_publishing_limit. */
  getPublishingLimit(): Promise<{ quota_usage: number; quota_total: number }>;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
  /** True when the send failed because the 24h messaging window is closed. */
  isWindowError(): boolean {
    return this.code === 10 || /24 hours|messaging window/i.test(this.message);
  }
}

const META_TIMEOUT_MS = 20_000;

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

function toMetaApiError(status: number, body: MetaErrorBody | null, fallback: string): MetaApiError {
  const e = body?.error;
  const message = e?.message || fallback;
  return new MetaApiError(message, e?.code, e?.error_subcode, status);
}

/** Low-level request. Resolves the (decrypted) token fresh on every call. */
async function metaRequest<T>(path: string, init: { method?: string; body?: unknown }): Promise<T> {
  const env = getEnv();
  const token = await getDecryptedToken();
  if (!token) {
    throw new MetaApiError(
      "Instagram token not configured — complete the token setup in /admin",
      undefined,
      undefined,
      401,
    );
  }
  const url = `${env.IG_API_BASE.replace(/\/$/, "")}/${env.IG_API_VERSION}${path}`;
  const reqInit: RequestInit = {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  };
  if (init.body !== undefined) reqInit.body = JSON.stringify(init.body);
  let res: Response;
  try {
    res = await fetch(url, reqInit);
  } catch (err) {
    throw new MetaApiError(
      `Meta API request failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      undefined,
      0,
    );
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw toMetaApiError(res.status, json as MetaErrorBody | null, `Meta API error (HTTP ${res.status})`);
  }
  return json as T;
}

function requireId(json: { id?: unknown }, what: string): string {
  if (!json || typeof json.id !== "string" || json.id.length === 0) {
    throw new MetaApiError(`Meta API did not return an id for ${what}`);
  }
  return json.id;
}

const KNOWN_STATUSES: ContainerStatus[] = ["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED"];

export function getMetaClient(): MetaClient {
  const env = requireMetaEnv();
  const igUserId = env.IG_USER_ID;

  return {
    async sendMessage(igsid: string, opts: SendMessageOpts): Promise<{ messageId: string }> {
      if (!opts.text && !opts.imageUrl) {
        throw new Error("sendMessage requires text and/or imageUrl");
      }
      const message: Record<string, unknown> = {};
      if (opts.text) message.text = opts.text;
      if (opts.imageUrl) {
        message.attachment = { type: "image", payload: { url: opts.imageUrl } };
      }
      if (opts.quickReplies && opts.quickReplies.length > 0) {
        if (opts.quickReplies.length > 13) {
          throw new Error("Meta allows at most 13 quick replies");
        }
        message.quick_replies = opts.quickReplies.map((q) => ({
          content_type: "text",
          title: q.title.slice(0, 20),
          payload: q.payload,
        }));
      }
      const json = await metaRequest<{ recipient_id?: string; message_id?: string }>(`/me/messages`, {
        method: "POST",
        body: {
          recipient: { id: igsid },
          messaging_type: "RESPONSE",
          message,
        },
      });
      if (!json.message_id) {
        throw new MetaApiError("Meta send returned no message_id");
      }
      return { messageId: json.message_id };
    },

    async createImageContainer(
      imageUrl: string,
      opts: { isCarouselItem?: boolean; caption?: string } = {},
    ): Promise<string> {
      const body: Record<string, unknown> = { image_url: imageUrl };
      if (opts.isCarouselItem) body.is_carousel_item = true;
      // No media_type on image containers ("IMAGE" is not a valid value).
      if (opts.caption && !opts.isCarouselItem) body.caption = opts.caption;
      const json = await metaRequest<{ id?: string }>(`/${igUserId}/media`, { method: "POST", body });
      return requireId(json, "image container");
    },

    async createCarouselContainer(children: string[], caption: string): Promise<string> {
      if (children.length < 2 || children.length > 10) {
        throw new Error(`Carousel needs 2–10 children, got ${children.length}`);
      }
      const json = await metaRequest<{ id?: string }>(`/${igUserId}/media`, {
        method: "POST",
        body: { media_type: "CAROUSEL", children: children.join(","), caption },
      });
      return requireId(json, "carousel container");
    },

    async getContainerStatus(containerId: string): Promise<ContainerStatus> {
      const json = await metaRequest<{ status_code?: string }>(
        `/${containerId}?fields=status_code`,
        {},
      );
      const s = json.status_code;
      if (s === "PUBLISHED") return "FINISHED"; // already live — treat as done
      if (s && (KNOWN_STATUSES as string[]).includes(s)) return s as ContainerStatus;
      throw new MetaApiError(`Unknown container status_code: ${String(s)}`);
    },

    async publishContainer(containerId: string): Promise<string> {
      const json = await metaRequest<{ id?: string }>(`/${igUserId}/media_publish`, {
        method: "POST",
        body: { creation_id: containerId },
      });
      return requireId(json, "published media");
    },

    async getPermalink(mediaId: string): Promise<string> {
      const json = await metaRequest<{ permalink?: string }>(`/${mediaId}?fields=permalink`, {});
      if (!json.permalink) {
        throw new MetaApiError("Meta API did not return a permalink");
      }
      return json.permalink;
    },

    async getPublishingLimit(): Promise<{ quota_usage: number; quota_total: number }> {
      const json = await metaRequest<unknown>(
        `/${igUserId}/content_publishing_limit?fields=quota_usage,config`,
        {},
      );
      // Shape A (documented): { data: [{ quota_usage, config: { quota_total, quota_duration } }]}
      // Shape B (some hosts):  { quota_usage, config: { quota_total, quota_duration } }
      const node =
        typeof json === "object" && json !== null && "data" in json
          ? (json as { data: unknown }).data
          : json;
      const entry = Array.isArray(node) ? node[0] : node;
      const quota_usage =
        typeof entry === "object" && entry !== null && "quota_usage" in entry
          ? (entry as { quota_usage: unknown }).quota_usage
          : undefined;
      const config =
        typeof entry === "object" && entry !== null && "config" in entry
          ? (entry as { config: unknown }).config
          : undefined;
      const quota_total =
        typeof config === "object" && config !== null && "quota_total" in config
          ? (config as { quota_total: unknown }).quota_total
          : undefined;
      if (typeof quota_usage !== "number" || typeof quota_total !== "number") {
        throw new MetaApiError("content_publishing_limit returned an unexpected shape");
      }
      return { quota_usage, quota_total };
    },
  };
}

/**
 * Decrypt + return the stored long-lived IG token, or null if absent.
 * Callers treat null as misconfigured: alert, never crash silently, never
 * proceed with Meta calls.
 */
export async function getDecryptedToken(): Promise<string | null> {
  let encKeyPresent = false;
  try {
    encKeyPresent = !!getEnv().IG_TOKEN_ENC_KEY;
  } catch {
    encKeyPresent = false;
  }
  const settings = await getAdminSettings();
  const rec = settings.token;
  if (!rec || !encKeyPresent) {
    if (rec && !encKeyPresent) {
      log.error("IG token stored but IG_TOKEN_ENC_KEY is not set — cannot decrypt");
    }
    return null;
  }
  try {
    return decryptToken(rec.enc, rec.iv);
  } catch (err) {
    log.error("Failed to decrypt stored IG token", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type { Condition };
