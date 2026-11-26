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
import { exchangeShortLivedToken } from "@/lib/tokens";
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

// Partial settings update — every field optional, but at least one is required.
// Bounds match the env-backed defaults (lib/env.ts) so the UI can never write
// a value the workers would reject.
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const settingsBody = z
  .object({
    publish_mode: z.enum(["review", "auto", "dry_run"]).optional(),
    max_posts_per_day: z.number().int().min(1).max(50).optional(),
    min_gap_minutes: z.number().int().min(0).max(1440).optional(),
    posting_window: z
      .object({ start: hhmm, end: hhmm, tz: z.string().min(1).max(64) })
      .optional(),
    retention_days: z.number().int().min(1).max(365).optional(),
    max_listings_per_seller_per_day: z.number().int().min(1).max(50).optional(),
    photo_debounce_seconds: z.number().int().min(5).max(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one setting is required",
  });

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
    // Full IGSID, never displayed — the Ban action posts it to /sellers/:id/ban.
    seller_igsid: data.seller_igsid,
    created_at: data.created_at,
    caption: data.caption,
    extracted: data.extracted,
    moderation: data.moderation,
    missing: data.missing,
    photo_count: data.photos.length,
    publish: {
      slot_at: data.publish.slot_at,
      permalink: data.publish.permalink,
      media_id: data.publish.media_id,
      // media_id set on a terminal listing means the post is live on IG
      // but the listing never reached PUBLISHED (worker wrote a
      // published_terminal event). Surface it so an admin cannot reject
      // or retry a live post by mistake (2026-11-24 audit HIGH #2).
      published_terminal:
        Boolean(data.publish.media_id) &&
        (data.status === "FAILED" || data.status === "REJECTED"),
      attempts: data.publish.attempts,
      last_error: data.publish.last_error,
    },
  };
}

/** Public settings shape — the same fields GET returns and POST echoes back. */
function settingsResponse(s: {
  global_kill_switch: boolean;
  publish_mode: string;
  max_posts_per_day: number;
  min_gap_minutes: number;
  posting_window: { start: string; end: string; tz: string };
  retention_days: number;
  max_listings_per_seller_per_day: number;
  photo_debounce_seconds: number;
}) {
  return {
    kill_switch: s.global_kill_switch,
    publish_mode: s.publish_mode,
    max_posts_per_day: s.max_posts_per_day,
    min_gap_minutes: s.min_gap_minutes,
    posting_window: s.posting_window,
    retention_days: s.retention_days,
    max_listings_per_seller_per_day: s.max_listings_per_seller_per_day,
    photo_debounce_seconds: s.photo_debounce_seconds,
  };
}
async function tryNotifySeller(igsid: string, text: string): Promise<void> {
  try {
    const { getMetaClient } = await import("@/lib/meta");
    await getMetaClient().sendMessage(igsid, { text });
  } catch (err) {
    // getMetaClient throws until Phase 4 lands; 24h-window failures land here too.
    log.warn("admin-api: seller DM skipped", { err: String(err).slice(0, 160) });
  }
}

/**
 * 409 response when publishing is paused by the global kill switch, null
 * when clear. Approve/retry must check this BEFORE mutating: without it an
 * approve returns {ok:true, enqueued:true} while the worker parks the
 * listing back to QUEUED and fires a Telegram "parked" alert — the admin
 * sees success, and each click spams another alert (2026-11-24 re-audit
 * Lane B N3).
 */
async function killSwitchBlock(): Promise<NextResponse | null> {
  const s = await getAdminSettings();
  return s.global_kill_switch
    ? NextResponse.json(
        { ok: false, error: "Publishing is paused (kill switch is on) — turn it off in /admin/kill before approving or retrying" },
        { status: 409 },
      )
    : null;
}

type ListingTransition<T> =
  | { found: false }
  | { found: true; doc: ListingDoc; result: T };

/**
 * Run one admin listing transition inside a Firestore transaction.
 *
 * The mutator receives the FRESH doc (re-read inside the transaction) and
 * returns the patch to apply — or no patch when the fresh state no longer
 * allows the action. This closes the admin TOCTOU race (2026-11-24 audit
 * HIGH #1): the old get → check → plain update let a stale approve/retry
 * overwrite a concurrent reject (or a worker transition), resurrecting a
 * terminal listing. With the check inside the transaction, exactly one
 * writer wins and the loser sees the winner's state.
 */
async function transitionListing<T>(
  id: string,
  mutate: (doc: ListingDoc) => { patch?: Record<string, unknown>; result: T },
): Promise<ListingTransition<T>> {
  const ref = adminDb().collection("listings").doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { found: false };
    const doc = snap.data() as ListingDoc;
    const { patch, result } = mutate(doc);
    if (patch) tx.update(ref, patch);
    return { found: true, doc, result };
  });
}

type ApproveTransition =
  | { kind: "live-media"; mediaId: string }
  | { kind: "conflict"; status: ListingStatus }
  | { kind: "applied"; previousStatus: ListingStatus; previousReview: ListingDoc["review"] };

type RejectTransition =
  | { kind: "live-media"; mediaId: string }
  | { kind: "conflict"; status: ListingStatus }
  | { kind: "applied"; sellerIgsid: string };

type CaptionTransition =
  | { kind: "live-media"; mediaId: string }
  | { kind: "conflict"; status: ListingStatus }
  | { kind: "applied" };

type RetryTransition =
  | { kind: "live-media"; mediaId: string }
  | { kind: "conflict"; status: ListingStatus }
  | { kind: "applied"; prevError: string | null };

/** 409 for actions on a listing whose post is already live on Instagram. */
function liveMediaConflict(action: string, mediaId: string): NextResponse {
  return NextResponse.json(
    {
      error: `Cannot ${action} this listing: its post is already live on Instagram (media_id ${mediaId}). Use the Instagram delete flow if it must come down.`,
    },
    { status: 409 },
  );
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
    return NextResponse.json(settingsResponse(s));
  }

  // GET /api/admin/activity — latest audit events across all listings.
  // NO collectionGroup query: it needs a composite index on the events
  // collection group, and Firestore answers FAILED_PRECONDITION (→ 500)
  // until that index exists and builds — 2026-11-23 the /admin/activity
  // page 500d exactly this way (the old comment claiming otherwise was
  // wrong; firestore.indexes.json has no events index). Instead, read
  // the latest events per listing and merge newest-first in memory —
  // the same pattern the queue endpoint uses. Single-collection orderBy
  // uses the auto single-field index, so this works with no index deploy.
  // photo_count is surfaced on finalized events (it decides the
  // burst-photo question: how many photos the extraction actually saw).
  if (a === "activity" && !b) {
    const listingsSnap = await adminDb()
      .collection("listings")
      .orderBy("created_at", "desc")
      .limit(50)
      .get();
    const perListing = await Promise.all(
      listingsSnap.docs.map(async (d) => {
        const ev = await d.ref.collection("events").orderBy("at", "desc").limit(10).get();
        return ev.docs.map((e) => {
          const data = e.data() as {
            type?: string;
            at?: string;
            by?: string | null;
            detail?: string | null;
            photo_count?: number;
            error?: string;
            attempt?: number;
            media_id?: string;
            status?: string;
          };
          return {
            id: e.id,
            listing_id: d.id,
            type: data.type ?? "unknown",
            at: data.at ?? null,
            by: data.by ?? null,
            detail: data.detail ?? null,
            photo_count: typeof data.photo_count === "number" ? data.photo_count : null,
            error: typeof data.error === "string" ? data.error : null,
            attempt: typeof data.attempt === "number" ? data.attempt : null,
            // published_terminal events carry the live media id + the
            // terminal listing status — surface both so the feed shows
            // that a post is live on IG (HIGH #2).
            media_id: typeof data.media_id === "string" ? data.media_id : null,
            listing_status: typeof data.status === "string" ? data.status : null,
          };
        });
      }),
    );
    const items = perListing
      .flat()
      .sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""))
      .slice(0, 25);
    return NextResponse.json({ items });
  }

  // GET /api/admin/sellers/banned — blocklist docs (id = seller IGSID).
  if (a === "sellers" && b === "banned") {
    const snap = await adminDb()
      .collection("blocklist")
      .orderBy("at", "desc")
      .limit(50)
      .get();
    const items = snap.docs.map((d) => {
      const data = d.data() as { reason?: string; at?: string; by?: string };
      return {
        igsid: d.id,
        reason: data.reason ?? "",
        at: data.at ?? null,
        by: data.by ?? null,
      };
    });
    return NextResponse.json({ items });
  }

  // GET /api/admin/token-health
  if (a === "token-health" && !b) {
    const s = await getAdminSettings();
    // Whether the daily Vercel cron can refresh the token at all: the cron
    // route fails closed (401) when CRON_SECRET is unset, so a missing
    // secret means the token NEVER auto-refreshes and the expiry silently
    // counts down. Surface it here (presence only, never the value) so
    // /admin shows the gap instead of Telegram (which is not configured).
    const cronConfigured = Boolean(getEnv().CRON_SECRET);
    if (!s.token) {
      return NextResponse.json({
        health: "missing",
        expires_at: null,
        days_left: null,
        ig_user_id: s.ig_user_id || null,
        updated_at: null,
        cron_configured: cronConfigured,
      });
    }
    return NextResponse.json({
      health: s.token_health,
      expires_at: s.token.expires_at,
      days_left: daysUntilExpiry(s.token.expires_at),
      ig_user_id: s.ig_user_id || null,
      updated_at: s.token.updated_at,
      cron_configured: cronConfigured,
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
    if (data.publish?.media_id) return liveMediaConflict("approve", data.publish.media_id);
    if (!["NEEDS_REVIEW", "SUBMITTED", "FAILED", "QUEUED"].includes(data.status)) {
      return NextResponse.json(
        { error: `Cannot approve a listing in status ${data.status}` },
        { status: 409 },
      );
    }
    const blocked = await killSwitchBlock();
    if (blocked) return blocked;
    // Atomic transition: re-validate status + media_id on the fresh doc
    // inside the transaction, so a concurrent reject/worker move between
    // the read above and this write cannot be overwritten (HIGH #1).
    const decidedAt = new Date().toISOString();
    const transition = await transitionListing<ApproveTransition>(b, (doc) => {
      if (doc.publish?.media_id) {
        return { result: { kind: "live-media" as const, mediaId: doc.publish.media_id } };
      }
      if (!["NEEDS_REVIEW", "SUBMITTED", "FAILED", "QUEUED"].includes(doc.status)) {
        return { result: { kind: "conflict" as const, status: doc.status } };
      }
      return {
        patch: {
          status: "APPROVED",
          review: { note: null, decided_by: by, decided_at: decidedAt },
        },
        result: {
          kind: "applied" as const,
          previousStatus: doc.status,
          previousReview: doc.review ?? { note: null, decided_by: null, decided_at: null },
        },
      };
    });
    if (!transition.found) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    if (transition.result.kind === "live-media") {
      return liveMediaConflict("approve", transition.result.mediaId);
    }
    if (transition.result.kind === "conflict") {
      return NextResponse.json(
        { error: `Cannot approve a listing in status ${transition.result.status}` },
        { status: 409 },
      );
    }
    const { previousStatus, previousReview } = transition.result;
    await appendListingEvent(b, "approved", { by, detail: "Approved in /admin" });
    const enqueued = await enqueuePublishWorker(b);
    if (!enqueued) {
      // The worker was never enqueued: roll the listing back to its
      // pre-approve status so the admin can approve again — otherwise it
      // would strand in APPROVED with no UI path to re-enqueue (approve
      // rejects APPROVED, retry requires FAILED). The rollback is itself
      // conditional: it only applies while the listing is still in THIS
      // approve's APPROVED state (same decider + timestamp), so a
      // concurrent reject or worker claim during the enqueue is never
      // overwritten by the rollback (HIGH #1, rollback leg).
      const rollback = await transitionListing(b, (doc) => {
        if (
          doc.status === "APPROVED" &&
          doc.review?.decided_by === by &&
          doc.review?.decided_at === decidedAt
        ) {
          return {
            patch: { status: previousStatus, review: previousReview },
            result: true,
          };
        }
        return { result: false };
      });
      const rolledBack = rollback.found && rollback.result;
      const leftIn = rolledBack
        ? previousStatus
        : rollback.found
          ? rollback.doc.status
          : previousStatus;
      await appendListingEvent(b, "approve_enqueue_failed", {
        by,
        detail: rolledBack
          ? `Publish worker could not be enqueued (QStash) — listing left in ${previousStatus}`
          : `Publish worker could not be enqueued (QStash) — listing changed concurrently and was left in ${leftIn}`,
      });
      log.warn("admin-api: approve enqueue failed", { listing: b, by, from: previousStatus, rolledBack, leftIn });
      return NextResponse.json(
        {
          ok: false,
          error: rolledBack
            ? `Publish worker could not be enqueued (QStash) — listing left in ${previousStatus}; try again`
            : `Publish worker could not be enqueued (QStash) — listing changed concurrently and was left in ${leftIn}; refresh and try again`,
        },
        { status: 502 },
      );
    }
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
    // A listing with media_id is already live on IG even when its status
    // is FAILED (published_terminal): rejecting it would mark a live post
    // REJECTED and retention would delete its originals (HIGH #2).
    if (data.publish?.media_id) return liveMediaConflict("reject", data.publish.media_id);
    // A PUBLISHING listing is mid-flight (containers created or
    // media_publish in progress): rejecting it here would not stop the
    // workers — the listing would end FAILED, not REJECTED, and the
    // seller would get the wrong outcome. PUBLISHED is already live on
    // IG (needs a delete flow, not a reject). REJECTED is terminal.
    if (["PUBLISHING", "PUBLISHED", "REJECTED"].includes(data.status)) {
      return NextResponse.json(
        { error: `Cannot reject a listing in status ${data.status}` },
        { status: 409 },
      );
    }
    // Atomic transition (HIGH #1): re-validate on the fresh doc so a
    // concurrent approve/worker move cannot be overwritten by this reject.
    const transition = await transitionListing<RejectTransition>(b, (doc) => {
      if (doc.publish?.media_id) {
        return { result: { kind: "live-media" as const, mediaId: doc.publish.media_id } };
      }
      if (["PUBLISHING", "PUBLISHED", "REJECTED"].includes(doc.status)) {
        return { result: { kind: "conflict" as const, status: doc.status } };
      }
      return {
        patch: {
          status: "REJECTED",
          review: { note: parsed.data.reason, decided_by: by, decided_at: new Date().toISOString() },
        },
        result: { kind: "applied" as const, sellerIgsid: doc.seller_igsid },
      };
    });
    if (!transition.found) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    if (transition.result.kind === "live-media") {
      return liveMediaConflict("reject", transition.result.mediaId);
    }
    if (transition.result.kind === "conflict") {
      return NextResponse.json(
        { error: `Cannot reject a listing in status ${transition.result.status}` },
        { status: 409 },
      );
    }
    await appendListingEvent(b, "rejected", { by, detail: parsed.data.reason });
    await tryNotifySeller(
      transition.result.sellerIgsid,
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
    const data = snap.data() as ListingDoc;
    if (data.publish?.media_id) return liveMediaConflict("edit the caption of", data.publish.media_id);
    // The caption is baked into the IG containers at publish time: editing
    // a PUBLISHING listing's caption would be silently lost (containers
    // already carry the old one), and a PUBLISHED listing's caption lives
    // on IG now. DRAFT / NEEDS_INFO have no generated caption to edit yet.
    // Allowlist (not blocklist): a future status defaults to "can't edit"
    // rather than a silently-lost edit.
    if (!["NEEDS_REVIEW", "CONFIRM", "SUBMITTED", "QUEUED", "APPROVED", "FAILED"].includes(data.status)) {
      return NextResponse.json(
        { error: `Cannot edit the caption of a listing in status ${data.status}` },
        { status: 409 },
      );
    }
    // Conditional write (HIGH #1 pattern): re-validate on the fresh doc so
    // a caption edit cannot land after a concurrent move to PUBLISHING.
    const transition = await transitionListing<CaptionTransition>(b, (doc) => {
      if (doc.publish?.media_id) {
        return { result: { kind: "live-media" as const, mediaId: doc.publish.media_id } };
      }
      if (!["NEEDS_REVIEW", "CONFIRM", "SUBMITTED", "QUEUED", "APPROVED", "FAILED"].includes(doc.status)) {
        return { result: { kind: "conflict" as const, status: doc.status } };
      }
      return { patch: { caption: parsed.data.caption }, result: { kind: "applied" as const } };
    });
    if (!transition.found) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    if (transition.result.kind === "live-media") {
      return liveMediaConflict("edit the caption of", transition.result.mediaId);
    }
    if (transition.result.kind === "conflict") {
      return NextResponse.json(
        { error: `Cannot edit the caption of a listing in status ${transition.result.status}` },
        { status: 409 },
      );
    }
    await appendListingEvent(b, "caption_edited", { by, detail: "Caption edited in /admin" });
    return NextResponse.json({ ok: true });
  }

  // POST /api/admin/listings/:id/retry
  if (a === "listings" && b && c === "retry") {
    const ref = adminDb().collection("listings").doc(b);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    const data = snap.data() as ListingDoc;
    if (data.publish?.media_id) return liveMediaConflict("retry", data.publish.media_id);
    if (data.status !== "FAILED") {
      return NextResponse.json(
        { error: `Only FAILED listings can be retried (current: ${data.status})` },
        { status: 409 },
      );
    }
    const blocked = await killSwitchBlock();
    if (blocked) return blocked;
    // Atomic transition (HIGH #1): re-validate FAILED + no media_id on the
    // fresh doc. Keep the original failure reason from the SAME fresh doc:
    // the rollback below restores it, or the retry's own failure would
    // erase the only record of why the listing FAILED (Fix #10 gap).
    const transition = await transitionListing<RetryTransition>(b, (doc) => {
      if (doc.publish?.media_id) {
        return { result: { kind: "live-media" as const, mediaId: doc.publish.media_id } };
      }
      if (doc.status !== "FAILED") {
        return { result: { kind: "conflict" as const, status: doc.status } };
      }
      return {
        patch: { status: "QUEUED", "publish.last_error": null },
        result: { kind: "applied" as const, prevError: doc.publish?.last_error ?? null },
      };
    });
    if (!transition.found) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    if (transition.result.kind === "live-media") {
      return liveMediaConflict("retry", transition.result.mediaId);
    }
    if (transition.result.kind === "conflict") {
      return NextResponse.json(
        { error: `Only FAILED listings can be retried (current: ${transition.result.status})` },
        { status: 409 },
      );
    }
    const prevError = transition.result.prevError;
    await appendListingEvent(b, "retry", { by, detail: "Re-queued from /admin" });
    const enqueued = await enqueuePublishWorker(b);
    if (!enqueued) {
      // Same strand as approve: a QUEUED listing with no worker enqueued
      // would never publish. Roll back to FAILED so the admin can retry —
      // conditionally, only while the listing is still in this retry's
      // QUEUED state (last_error still cleared), so a concurrent reject or
      // worker move during the enqueue is never overwritten (HIGH #1).
      const rollback = await transitionListing(b, (doc) => {
        if (doc.status === "QUEUED" && (doc.publish?.last_error ?? null) === null) {
          return {
            patch: { status: "FAILED", "publish.last_error": prevError },
            result: true,
          };
        }
        return { result: false };
      });
      const rolledBack = rollback.found && rollback.result;
      const leftIn = rolledBack ? "FAILED" : rollback.found ? rollback.doc.status : "FAILED";
      await appendListingEvent(b, "retry_enqueue_failed", {
        by,
        detail: rolledBack
          ? "Publish worker could not be enqueued (QStash) — listing left in FAILED"
          : `Publish worker could not be enqueued (QStash) — listing changed concurrently and was left in ${leftIn}`,
      });
      log.warn("admin-api: retry enqueue failed", { listing: b, by, rolledBack, leftIn });
      return NextResponse.json(
        {
          ok: false,
          error: rolledBack
            ? "Publish worker could not be enqueued (QStash) — listing left in FAILED; try again"
            : `Publish worker could not be enqueued (QStash) — listing changed concurrently and was left in ${leftIn}; refresh and try again`,
        },
        { status: 502 },
      );
    }
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

  // POST /api/admin/sellers/:igsid/unban
  if (a === "sellers" && b && c === "unban") {
    const ref = adminDb().doc(`blocklist/${b}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Seller is not banned" }, { status: 404 });
    }
    await ref.delete();
    await adminDb().doc(`conversations/${b}`).set({ blocked: false }, { merge: true });
    await notifyAdmin(`✅ Seller unbanned by ${by}\nIGSID: ${truncId(b)}`);
    log.info("admin-api: seller unbanned", { by });
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

  // POST /api/admin/settings — partial update, validated by settingsBody.
  // kill_switch is intentionally NOT writable here (use /kill-switch).
  if (a === "settings" && !b) {
    const parsed = settingsBody.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return NextResponse.json(
        { error: `Invalid settings: ${detail}` },
        { status: 400 },
      );
    }
    await updateAdminSettings(parsed.data);
    const s = await getAdminSettings();
    log.info("admin-api: settings updated", {
      by,
      keys: Object.keys(parsed.data).join(","),
    });
    return NextResponse.json({ ok: true, settings: settingsResponse(s) });
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
    // The pasted token is SHORT-LIVED (~1h from the Meta dashboard). Never
    // store it as-is: exchange it for a 60-day long-lived token first, and
    // store the exchanged token with Meta's real expires_in. Storing the
    // pasted string with a fabricated 60-day expiry left the app believing
    // it had a healthy token that actually died within the hour.
    let exchanged: { token: string; expires_in: number };
    try {
      exchanged = await exchangeShortLivedToken(parsed.data.token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("admin-api: token exchange failed — nothing stored", { by, err: msg.slice(0, 200) });
      return NextResponse.json(
        { ok: false, error: `Token exchange failed: ${msg.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const expires_at = new Date(Date.now() + exchanged.expires_in * 1000).toISOString();
    await storeToken(exchanged.token, expires_at);
    await updateAdminSettings({ token_health: "ok" });
    log.info("admin-api: token saved manually from UI", { by });
    return NextResponse.json({ ok: true, expires_at, days_left: exchanged.expires_in / 86400 });
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
