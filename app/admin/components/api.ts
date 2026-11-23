/**
 * Authenticated fetch helper for /admin — every call carries
 * `Authorization: Bearer <Firebase ID token>`.
 */
import { getClientAuth } from "../firebase-client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const user = getClientAuth().currentUser;
  if (!user) throw new ApiError(401, "Not signed in");
  const idToken = await user.getIdToken();
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown): Promise<T> =>
  adminFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

// --- API response shapes ----------------------------------------------------

export interface QueueItem {
  id: string;
  status: string;
  seller: string;
  created_at: string;
  caption: string | null;
  extracted: {
    title: string;
    category: string | null;
    gender: string | null;
    brand: string | null;
    color: string | null;
    size: string | null;
    condition: string | null;
    price_pkr: number | null;
    city: string | null;
    defects: string[];
    measurements: string | null;
  } | null;
  moderation: { verdict: string; reasons: string[] } | null;
  missing: string[];
  photo_count: number;
  photo_urls: string[];
  publish: { slot_at: string | null; permalink: string | null; attempts: number; last_error: string | null };
}

export interface PublishLogRow {
  id: string;
  permalink: string | null;
  published_at: string | null;
  slot_at: string | null;
  latency_s: number | null;
  attempts: number;
  seller: string;
}

export interface QuotaInfo {
  today_count: number;
  max: number;
  meta: { quota_usage: number; quota_total: number } | null;
}

export interface SettingsInfo {
  kill_switch: boolean;
  publish_mode: string;
  max_posts_per_day: number;
  min_gap_minutes: number;
  posting_window: { start: string; end: string; tz: string };
  retention_days: number;
}

export interface TokenHealthInfo {
  health: "ok" | "degraded" | "missing";
  expires_at: string | null;
  days_left: number | null;
  ig_user_id: string | null;
  updated_at: string | null;
}
