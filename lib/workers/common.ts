/**
 * Shared plumbing for the Phase 4 workers (publish + poll-container).
 *
 * Dependency-injected so unit tests run hermetic (fake deps) while production
 * wires the real modules via defaultWorkerDeps(). The kill switch is re-read
 * from Firestore before EVERY Meta API call (plan §10).
 */
import { enqueueWorker } from "@/lib/qstash";
import {
  appendListingEvent,
  col,
  db,
  getAdminSettings,
  getDailyPostCount,
  getLastPublishAt,
  getListing,
  incrementDailyPostCount,
  saveListing,
  setLastPublishAt,
} from "@/lib/db";
import { downloadBytes, signedReadUrl, uploadBytes } from "@/lib/storage";
import { processSlide } from "@/lib/images";
import { getMetaClient, MetaApiError, type MetaClient } from "@/lib/meta";
import { notifyAdmin } from "@/lib/telegram";
import { log } from "@/lib/log";
import type {
  AdminSettings,
  DeepPartial,
  ListingDoc,
  ListingStatus,
  PollContainerPayload,
} from "@/lib/types";

/** Thrown when the global kill switch is on — the job parks, never proceeds. */
export class KillSwitchEngaged extends Error {
  constructor() {
    super("global kill switch engaged");
    this.name = "KillSwitchEngaged";
  }
}

export interface ClaimResult {
  /** Fresh listing doc. */
  doc: ListingDoc;
  /** True when this caller won the claim (status → PUBLISHING + lease). */
  claimed: boolean;
  /** True when the listing is already PUBLISHED (duplicate delivery). */
  alreadyPublished: boolean;
  /** Status before the claim write (the claim flips it to PUBLISHING). */
  preStatus: ListingStatus;
}

export interface WorkerDeps {
  now(): Date;
  /** Atomic claim: SUBMITTED/APPROVED/QUEUED (or stale PUBLISHING) → PUBLISHING. */
  claimListing(id: string): Promise<ClaimResult | null>;
  getListing(id: string): Promise<ListingDoc | null>;
  saveListing(id: string, patch: DeepPartial<ListingDoc>): Promise<void>;
  appendEvent(listingId: string, type: string, data?: Record<string, unknown>): Promise<void>;
  getSettings(): Promise<AdminSettings>;
  getPostsToday(day: string): Promise<number>;
  getLastPublish(): Promise<Date | null>;
  /** Increment the PKT-day counter + record the publish instant. */
  recordPublish(day: string, at: Date): Promise<void>;
  download(path: string): Promise<Buffer>;
  upload(path: string, data: Buffer, contentType: string): Promise<void>;
  signedUrl(path: string, hours: number): Promise<string>;
  processImage(raw: Buffer): Promise<Buffer>;
  getMeta(): MetaClient;
  enqueuePublish(listingId: string, opts: { notBefore: Date; deduplicationId: string }): Promise<void>;
  enqueuePoll(p: PollContainerPayload, opts: { delaySec: number; deduplicationId: string }): Promise<void>;
  notify(text: string, opts?: { listingId?: string }): Promise<void>;
}

/** Production wiring of WorkerDeps (real Firestore / Storage / Meta / QStash). */
export function defaultWorkerDeps(): WorkerDeps {
  return {
    now: () => new Date(),
    claimListing: async (id: string) => {
      const now = new Date();
      const ref = col("listings").doc(id);
      return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const doc = snap.data() as ListingDoc;
        const preStatus = doc.status;
        if (doc.status === "PUBLISHED") return { doc, claimed: false, alreadyPublished: true, preStatus };
        // media_id set but not marked PUBLISHED → crashed after publish; the
        // caller recovers via getPermalink (no claim needed — idempotent).
        if (doc.publish.media_id) return { doc, claimed: false, alreadyPublished: false, preStatus };
        const lockMs = doc.publish.locked_until ? new Date(doc.publish.locked_until).getTime() : 0;
        const lockFree = !doc.publish.locked_until || lockMs < now.getTime();
        const claimable: ListingStatus[] = ["SUBMITTED", "APPROVED", "QUEUED"];
        const ok = claimable.includes(doc.status) || (doc.status === "PUBLISHING" && lockFree);
        if (!ok) return { doc, claimed: false, alreadyPublished: false, preStatus };
        const locked_until = new Date(now.getTime() + 10 * 60_000).toISOString();
        tx.set(ref, { status: "PUBLISHING", publish: { locked_until } }, { merge: true });
        return {
          doc: { ...doc, status: "PUBLISHING", publish: { ...doc.publish, locked_until } },
          claimed: true,
          alreadyPublished: false,
          preStatus,
        };
      });
    },
    getListing,
    saveListing,
    appendEvent: (listingId, type, data) => appendListingEvent(listingId, { type, ...data }),
    getSettings: getAdminSettings,
    getPostsToday: getDailyPostCount,
    getLastPublish: getLastPublishAt,
    recordPublish: async (day, at) => {
      await incrementDailyPostCount(day);
      await setLastPublishAt(at);
    },
    download: downloadBytes,
    upload: uploadBytes,
    signedUrl: signedReadUrl,
    processImage: (raw) => processSlide(raw),
    getMeta: getMetaClient,
    enqueuePublish: (listingId, opts) =>
      enqueueWorker(
        "publish",
        { kind: "publish", listing_id: listingId },
        { notBefore: Math.floor(opts.notBefore.getTime() / 1000), deduplicationId: opts.deduplicationId },
      ),
    enqueuePoll: (p, opts) =>
      enqueueWorker("poll-container", p, { delaySec: opts.delaySec, deduplicationId: opts.deduplicationId }),
    notify: (text, opts) => notifyAdmin(text, opts),
  };
}

/**
 * Re-read admin settings and throw KillSwitchEngaged when the switch is on.
 * Call immediately before EVERY Meta API call.
 */
export async function liveSettings(deps: WorkerDeps): Promise<AdminSettings> {
  const s = await deps.getSettings();
  if (s.global_kill_switch) throw new KillSwitchEngaged();
  return s;
}

/** Park a job because the kill switch is on: keep state, clear the lease, alert. */
export async function parkForKillSwitch(deps: WorkerDeps, listing: ListingDoc): Promise<void> {
  await deps.saveListing(listing.id, {
    publish: { ...listing.publish, locked_until: null, last_error: "killed" },
  });
  await deps.appendEvent(listing.id, "killed_parked", {});
  await deps.notify(`🛑 Kill switch ON — publish parked for listing ${listing.id}`, {
    listingId: listing.id,
  });
  log.warn("publish parked: kill switch engaged", { listing_id: listing.id });
}

/** Neutral seller-facing failure DM (never blames the seller, no internals). */
export const SELLER_FAILURE_DM =
  "Assalam-o-Alaikum! Aapki listing post karte waqt aik technical masla aa gaya hai. " +
  "Hamari team isay dekh rahi hai — aapko jald update mil jayegi. 🤍 — Team ReVault";

/** Mark FAILED: attempts++, last_error, event, Telegram alert, neutral seller DM. */
export async function failListing(deps: WorkerDeps, listing: ListingDoc, reason: string): Promise<void> {
  const msg = reason.slice(0, 300);
  await deps.saveListing(listing.id, {
    status: "FAILED",
    publish: {
      ...listing.publish,
      attempts: listing.publish.attempts + 1,
      last_error: msg,
      locked_until: null,
    },
  });
  await deps.appendEvent(listing.id, "failed", { error: msg });
  await deps.notify(`❌ Publish pipeline failed for listing ${listing.id}: ${msg}`, {
    listingId: listing.id,
  });
  try {
    await deps.getMeta().sendMessage(listing.seller_igsid, { text: SELLER_FAILURE_DM });
  } catch (dmErr) {
    if (dmErr instanceof MetaApiError && dmErr.isWindowError()) {
      log.info("failure DM skipped — 24h messaging window closed", { listing_id: listing.id });
    } else {
      log.warn("failure DM failed", {
        listing_id: listing.id,
        error: dmErr instanceof Error ? dmErr.message : String(dmErr),
      });
    }
  }
  log.error("listing marked FAILED", { listing_id: listing.id, error: msg });
}
