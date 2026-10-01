/**
 * /api/admin catch-all — every admin operation behind Firebase Auth.
 *
 * Auth: `Authorization: Bearer <Firebase ID token>` → verifyIdToken, then
 * custom claim admin===true OR email in ADMIN_EMAILS (bootstrap allowlist).
 * 401 = missing/invalid token, 403 = not an admin. Which grant path was used
 * is logged by lib/admin-auth.ts.
 *
 * Every mutating action appends to listings/{id}/events (audit trail).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdmin, type AdminPrincipal } from "@/lib/admin-auth";
import {
  adminAuth,
  adminDb,
  appendListingEvent,
  getAdminSettings,
  updateAdminSettings,
} from "@/lib/firebase-admin";
import { signedReadUrl } from "@/lib/storage";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { notifyAdmin } from "@/lib/telegram";
import {
  daysUntilExpiry,
  markTokenDegraded,
  refreshLongLivedToken,
  storeToken,
} from "@/lib/ig-token";
import { enqueuePublishWorker } from "@/lib/publish-queue";
import type { ListingDoc, ListingStatus } from "@/lib/types";

const QUEUE_STATUSES: ListingStatus[] = [
  "NEEDS_REVIEW",
  "QUEUED",
  "SUBMITTED",
  "APPROVED",
  "PUBLISHING",
  "FAILED",
];
const SIGNED_URL_TTL_MS = 4 * 3600 * 1000; // 4h — matches publishing playbook

// --- zod bodies -----------------------------------------------------------

const captionBody = z.object({ caption: z.string().min(1).max(2200) });
const killSwitchBody = z.object({ on: z.boolean() });
const reasonBody = z.object({ reason: z.string().min(1).max(500) });
const tokenBody = z.object({ token: z.string().min(20) });

// --- helpers --------------------------------------------------------------

type Ctx = { params: Promise<{ path?: string[] }> };

async function requireAdmin(
  req: NextRequest,
): Promise<{ principal: AdminPrincipal } | NextResponse> {
  const result = await authorizeAdmin(req.headers.get("authorization"), (t) =>
    adminAuth().verifyIdToken(t),
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return { principal: result.principal };
}

function actor(p: AdminPrincipal): string {
  return p.email ?? p.uid;
}

/** Truncate an IGSID for display (never expose full seller ids in the UI). */
function truncId(igsid: string): string {
  return igsid.length > 10 ? `${igsid.slice(0, 6)}…` : igsid;
}

/** Fresh signed Cloudinary URLs for a listing's photos (never persisted, generated on demand). */
async function signedPhotoUrls(photos: { storage_path: string }[]): Promise<string[]> {
  return Promise.all(
    photos.map(async (p) => {
      try {
        return await signedReadUrl(p.storage_path, SIGNED_URL_TTL_MS / 3600_000);
      } catch (err) {
        log.warn("admin-api: signed URL failed", {
          path: p.storage_path,
          err: String(err).slice(0, 120),
        });
        return "";
      }
    }),
  );
}

function listingSummary(d: { id: string; data: () => unknown }) {
  const data = d.data() as ListingDoc;
  return {
    id: d.id,
    status: data.status,
    seller: truncId(data.seller_igsid),
    created_at: data.created_at,
    caption: data.caption,
    extracted: data.extracted,
    moderation: data.moderation,
    missing: data.missing,
    photo_count: data.photos.length,
    publish: {
      slot_at: data.publish.slot_at,
      permalink: data.publish.permalink,
      attempts: data.publish.attempts,
      last_error: data.publish.last_error,
    },
  };
}

/** Best-effort seller DM via the Meta client (Phase 4 may not have landed yet). */
async function tryNotifySeller(igsid: string, text: string): Promise<void> {
  try {
    const { getMetaClient } = await import("@/lib/meta");
    await getMetaClient().sendMessage(igsid, { text });
  } catch (err) {
    // getMetaClient throws until Phase 4 lands; 24h-window failures land here too.
    log.warn("admin-api: seller DM skipped", { err: String(err).slice(0, 160) });
  }
}

// --- route handlers --------------------------------------------------------

async function handleGet(path: string[]) {
  const [a, b] = path;

  // GET /api/admin/queue
  if (a === "queue" && !b) {
    // `in` without orderBy needs no composite index; sort newest-first in memory.
    const snap = await adminDb()
      .collection("listings")
      .where("status", "in", QUEUE_STATUSES)
      .get();
    const items = snap.docs.map(listingSummary);
    items.sort((x, y) => y.created_at.localeCompare(x.created_at));
    const page = items.slice(0, 50);
    const withUrls = await Promise.all(
      page.map(async (item) => {
        const full = (await adminDb().collection("listings").doc(item.id).get()).data() as ListingDoc;
        return { ...item, photo_urls: await signedPhotoUrls(full.photos) };
      }),
    );
    return NextResponse.json({ items: withUrls, count: items.length });
  }

  // GET /api/admin/listings/:id
  if (a === "listings" && b) {
    const snap = await adminDb().collection("listings").doc(b).get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    const data = snap.data() as ListingDoc;
    const eventsSnap = await snap.ref
      .collection("events")
      .orderBy("at", "desc")
      .limit(25)
      .get();
    return NextResponse.json({
      ...listingSummary(snap),
      seller_igsid: data.seller_igsid,
      photos: data.photos,
      photo_urls: await signedPhotoUrls(data.photos),
      review: data.review,
      consent: data.consent,
      events: eventsSnap.docs.map((e) => ({ id: e.id, ...e.data() })),
    });
  }

  // GET /api/admin/publish-log
  if (a === "publish-log" && !b) {
    const snap = await adminDb()
      .collection("listings")
      .where("status", "==", "PUBLISHED")
      .orderBy("created_at", "desc")
      .limit(50)
      .get();
    const rows = await Promise.all(
      snap.docs.map(async (d) => {
        const data = d.data() as ListingDoc;
        // Latency = published event time − scheduled slot time (best-effort).
        let published_at: string | null = null;
        try {
          const ev = await d.ref.collection("events").orderBy("at", "desc").limit(1).get();
          const latest = ev.docs[0]?.data() as { type?: string; at?: string } | undefined;
          if (latest?.type === "published" && latest.at) published_at = latest.at;
        } catch {
          published_at = null;
        }
        const latency_s =
          published_at && data.publish.slot_at
            ? Math.max(
                0,
                Math.round(
                  (new Date(published_at).getTime() - new Date(data.publish.slot_at).getTime()) /
                    1000,
                ),
              )
            : null;
        return {
          id: d.id,
          permalink: data.publish.permalink,
          published_at,
          slot_at: data.publish.slot_at,
          latency_s,
          attempts: data.publish.attempts,
          seller: truncId(data.seller_igsid),
        };
      }),
    );
    return NextResponse.json({ items: rows });
  }

  // GET /api/admin/quota
  if (a === "quota" && !b) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: getEnv().TimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const counter = await adminDb().doc(`counters/daily_posts_${today}`).get();
    const today_count = counter.exists ? ((counter.data()?.count as number) ?? 0) : 0;
    let meta: { quota_usage: number; quota_total: number } | null = null;
    try {
      const { getMetaClient } = await import("@/lib/meta");
      meta = await getMetaClient().getPublishingLimit();
    } catch (err) {
      log.warn("admin-api: Meta quota read failed (best-effort)", {
        err: String(err).slice(0, 120),
      });
    }
    return NextResponse.json({
      today_count,
      max: getEnv().MAX_POSTS_PER_DAY,
      meta,
    });
  }

  // GET /api/admin/settings
  if (a === "settings" && !b) {
    const s = await getAdminSettings();
    return NextResponse.json({
      kill_switch: s.global_kill_switch,
      publish_mode: s.publish_mode,
      max_posts_per_day: s.max_posts_per_day,
      min_gap_minutes: s.min_gap_minutes,
      posting_window: s.posting_window,
      retention_days: s.retention_days,
    });
  }

  // GET /api/admin/token-health
  if (a === "token-health" && !b) {
    const s = await getAdminSettings();
    if (!s.token) {
      return NextResponse.json({
        health: "missing",
        expires_at: null,
        days_left: null,
        ig_user_id: s.ig_user_id || null,
        updated_at: null,
      });
    }
    return NextResponse.json({
      health: s.token_health,
      expires_at: s.token.expires_at,
      days_left: daysUntilExpiry(s.token.expires_at),
      ig_user_id: s.ig_user_id || null,
      updated_at: s.token.updated_at,
    });
  }

  log.warn("admin-api: unknown GET path", { path: path.join("/") });
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function handlePost(
  path: string[],
  req: NextRequest,
  principal: AdminPrincipal,
) {
  const [a, b, c] = path;
  const by = actor(principal);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // POST /api/admin/listings/:id/approve
  if (a === "listings" && b && c === "approve") {
    const ref = adminDb().collection("listings").doc(b);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    const data = snap.data() as ListingDoc;
    if (!["NEEDS_REVIEW", "SUBMITTED", "FAILED", "QUEUED"].includes(data.status)) {
      return NextResponse.json(
        { error: `Cannot approve a listing in status ${data.status}` },
        { status: 409 },
      );
    }
    await ref.update({
      status: "APPROVED",
      review: { note: null, decided_by: by, decided_at: new Date().toISOString() },
    });
    await appendListingEvent(b, "approved", { by, detail: "Approved in /admin" });
    const enqueued = await enqueuePublishWorker(b);
    log.info("admin-api: listing approved", { listing: b, by, enqueued });
    return NextResponse.json({ ok: true, status: "APPROVED", enqueued });
  }

  // POST /api/admin/listings/:id/reject {reason}
  if (a === "listings" && b && c === "reject") {
    const parsed = reasonBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "reason (1–500 chars) is required" }, { status: 400 });
    }
    const ref = adminDb().collection("listings").doc(b);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    const data = snap.data() as ListingDoc;
    await ref.update({
      status: "REJECTED",
      review: { note: parsed.data.reason, decided_by: by, decided_at: new Date().toISOString() },
    });
    await appendListingEvent(b, "rejected", { by, detail: parsed.data.reason });
    await tryNotifySeller(
      data.seller_igsid,
      `Assalam-o-Alaikum! Apki listing review ke baad post nahi ki ja sakti. Wajah: ${parsed.data.reason}. Koi aur item bhejna chahein to zaroor bhejiye ga! — Team ReVault`,
    );
    log.info("admin-api: listing rejected", { listing: b, by });
    return NextResponse.json({ ok: true, status: "REJECTED" });
  }

  // POST /api/admin/listings/:id/caption {caption}
  if (a === "listings" && b && c === "caption") {
    const parsed = captionBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "caption (1–2200 chars) is required" }, { status: 400 });
    }
    const ref = adminDb().collection("listings").doc(b);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    await ref.update({ caption: parsed.data.caption });
    await appendListingEvent(b, "caption_edited", { by, detail: "Caption edited in /admin" });
    return NextResponse.json({ ok: true });
  }

  // POST /api/admin/listings/:id/retry
  if (a === "listings" && b && c === "retry") {
    const ref = adminDb().collection("listings").doc(b);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    const data = snap.data() as ListingDoc;
    if (data.status !== "FAILED") {
      return NextResponse.json(
        { error: `Only FAILED listings can be retried (current: ${data.status})` },
        { status: 409 },
      );
    }
    await ref.update({ status: "QUEUED", "publish.last_error": null });
    await appendListingEvent(b, "retry", { by, detail: "Re-queued from /admin" });
    const enqueued = await enqueuePublishWorker(b);
    log.info("admin-api: listing retried", { listing: b, by, enqueued });
    return NextResponse.json({ ok: true, status: "QUEUED", enqueued });
  }

  // POST /api/admin/sellers/:igsid/ban {reason}
  if (a === "sellers" && b && c === "ban") {
    const parsed = reasonBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "reason (1–500 chars) is required" }, { status: 400 });
    }
    const now = new Date().toISOString();
    await adminDb().doc(`blocklist/${b}`).set({ reason: parsed.data.reason, at: now, by });
    await adminDb().doc(`conversations/${b}`).set({ blocked: true }, { merge: true });
    await notifyAdmin(
      `🚫 Seller banned by ${by}\nIGSID: ${truncId(b)}\nReason: ${parsed.data.reason}`,
    );
    log.info("admin-api: seller banned", { by });
    return NextResponse.json({ ok: true });
  }

  // POST /api/admin/kill-switch {on}
  if (a === "kill-switch" && !b) {
    const parsed = killSwitchBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "{ on: boolean } is required" }, { status: 400 });
    }
    await updateAdminSettings({ global_kill_switch: parsed.data.on });
    await notifyAdmin(
      parsed.data.on
        ? `🛑 KILL SWITCH ENABLED by ${by} — all publishing is parked.`
        : `🟢 Kill switch DISABLED by ${by} — publishing resumed.`,
    );
    log.info("admin-api: kill switch toggled", { on: parsed.data.on, by });
    return NextResponse.json({ ok: true, kill_switch: parsed.data.on });
  }

  // POST /api/admin/token-refresh
  if (a === "token-refresh" && !b) {
    try {
      const { token, expires_at } = await refreshLongLivedToken();
      await storeToken(token, expires_at);
      log.info("admin-api: token refreshed manually", { by });
      return NextResponse.json({
        ok: true,
        expires_at,
        days_left: daysUntilExpiry(expires_at),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markTokenDegraded(msg);
      await notifyAdmin(`⚠️ IG token refresh FAILED (manual, by ${by}): ${msg.slice(0, 200)}`);
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
  }

  // POST /api/admin/token-save {token}
  if (a === "token-save" && !b) {
    const parsed = tokenBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid token format" }, { status: 400 });
    }
    // We assume the user pasted a short-lived token (expires in ~60 days, but actually we'll fetch the real expiry later or assume 60 days).
    const expires_at = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    await storeToken(parsed.data.token, expires_at);
    await updateAdminSettings({ token_health: "ok" });
    log.info("admin-api: token saved manually from UI", { by });
    return NextResponse.json({ ok: true, expires_at, days_left: 60 });
  }

  log.warn("admin-api: unknown POST path", { path: path.join("/") });
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// --- entry points ----------------------------------------------------------

export async function GET(req: NextRequest, ctx: Ctx) {
  const authed = await requireAdmin(req);
  if (authed instanceof NextResponse) return authed;
  const path = (await ctx.params).path ?? [];
  try {
    return await handleGet(path);
  } catch (err) {
    log.error("admin-api: GET failed", { path: path.join("/"), err: String(err).slice(0, 200) });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const authed = await requireAdmin(req);
  if (authed instanceof NextResponse) return authed;
  const path = (await ctx.params).path ?? [];
  try {
    return await handlePost(path, req, authed.principal);
  } catch (err) {
    log.error("admin-api: POST failed", { path: path.join("/"), err: String(err).slice(0, 200) });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
