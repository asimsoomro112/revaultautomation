/**
 * Poll-container worker — Phase 4.
 *
 * Invoked by QStash with { kind:"poll-container", listing_id, container_id,
 * role:"child"|"parent", attempt }:
 *  - Re-read kill switch (park if on).
 *  - getContainerStatus; FINISHED → advance the pipeline:
 *      child (all children FINISHED, no parent yet) → createCarouselContainer →
 *        enqueue poll for the parent (delaySec 30).
 *      child when the listing has a single photo → publish directly.
 *      parent FINISHED → media_publish (skipped in dry_run) → permalink →
 *        PUBLISHED + daily counter + seller DM.
 *  - ERROR/EXPIRED → recreate that container with a fresh 4h signed URL
 *      (attempts++; >3 → FAILED + alert + neutral seller DM).
 *      Subcode 2207027 ("still processing") is treated as IN_PROGRESS —
 *      the container is NEVER recreated for it.
 *  - IN_PROGRESS (or transient status-call failure) → re-enqueue with
 *      backoff min(30*2^attempt, 300); attempt > 8 → FAILED.
 *  - Idempotent: PUBLISHED / media_id already set → no-op (two poll workers
 *    can never publish the same listing twice).
 */
import { tzDay } from "@/lib/schedule";
import { log } from "@/lib/log";
import {
  failListing,
  liveSettings,
  parkForKillSwitch,
  KillSwitchEngaged,
  type WorkerDeps,
} from "./common";
import type { ContainerStatus, MetaApiError } from "@/lib/meta";
import type { ListingDoc, PollContainerPayload } from "@/lib/types";

/** Meta subcode: container still processing — keep polling, never recreate. */
const STILL_PROCESSING_SUBCODE = 2207027;

const MAX_RECREATE_ATTEMPTS = 3;
const MAX_POLL_ATTEMPTS = 8;

export interface PollOutcome {
  outcome:
    | "missing"
    | "already-published"
    | "recovered"
    | "killed"
    | "not-claimed"
    | "waiting-children"
    | "parent-created"
    | "published"
    | "dry-run"
    | "recreated"
    | "requeued"
    | "failed"
    | "unknown-container";
  permalink?: string;
  error?: string;
}

export const SELLER_PUBLISHED_DM = (permalink: string): string =>
  `🎉 Mubarak ho! Aapki listing ReVault par live ho gayi hai:\n${permalink}\n\nBuyers ab aapko DM kar sakte hain. Shukriya! 🤍 — Team ReVault`;

export async function handlePollContainer(
  payload: PollContainerPayload,
  deps: WorkerDeps,
): Promise<PollOutcome> {
  const { listing_id: listingId, container_id: containerId, role } = payload;

  // --- 0. Load + idempotency ----------------------------------------------------
  let listing = await deps.getListing(listingId);
  if (!listing) {
    log.warn("poll worker: listing not found", { listing_id: listingId });
    return { outcome: "missing" };
  }
  if (listing.status === "PUBLISHED") {
    log.info("poll worker: already PUBLISHED, no-op", { listing_id: listingId });
    return { outcome: "already-published" };
  }
  if (listing.publish.media_id) {
    // Another worker published while this poll was in flight — finalize.
    return finalizePublished(deps, listing, listing.publish.media_id);
  }

  // --- 1. Kill switch ------------------------------------------------------------
  try {
    await liveSettings(deps);
  } catch (err) {
    if (err instanceof KillSwitchEngaged) {
      await parkForKillSwitch(deps, listing);
      return { outcome: "killed" };
    }
    throw err;
  }

  const meta = deps.getMeta();
  const isKnownContainer =
    listing.publish.container_ids.includes(containerId) ||
    listing.publish.parent_container_id === containerId;
  if (!isKnownContainer) {
    log.warn("poll worker: unknown container id", { listing_id: listingId, container_id: containerId });
    return { outcome: "unknown-container" };
  }

  // --- 2. Status ------------------------------------------------------------------
  let status: ContainerStatus;
  try {
    status = await meta.getContainerStatus(containerId);
  } catch (err) {
    // Still-processing subcode → keep polling, never recreate.
    if (isMetaSubcode(err, STILL_PROCESSING_SUBCODE)) {
      log.info("poll worker: subcode 2207027 (still processing) — keep polling", {
        listing_id: listingId,
        container_id: containerId,
      });
      status = "IN_PROGRESS";
    } else {
      // Transient status-call failure → backoff like IN_PROGRESS.
      log.warn("poll worker: status call failed, backing off", {
        listing_id: listingId,
        container_id: containerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return requeueBackoff(deps, listing, payload, `status call failed`);
    }
  }
  await deps.saveListing(listingId, {
    publish: { container_status: { [containerId]: status } },
  });
  // Re-read so children-completion checks see the fresh map.
  listing = (await deps.getListing(listingId)) ?? listing;

  // --- 3. FINISHED ------------------------------------------------------------------
  if (status === "FINISHED") {
    try {
      return await handleFinished(deps, listing, payload, meta);
    } catch (err) {
      if (err instanceof KillSwitchEngaged) {
        await parkForKillSwitch(deps, listing);
        return { outcome: "killed" };
      }
      throw err;
    }
  }

  // --- 4. ERROR / EXPIRED → recreate with a fresh signed URL -------------------------
  if (status === "ERROR" || status === "EXPIRED") {
    const attempts = listing.publish.attempts + 1;
    if (attempts > MAX_RECREATE_ATTEMPTS) {
      await failListing(deps, listing, `container ${status} after ${attempts} attempts`);
      return { outcome: "failed", error: "container error attempts exhausted" };
    }
    try {
      await liveSettings(deps);
      const fresh = await deps.getListing(listingId);
      const cur: ListingDoc = fresh ?? listing;
      let newId: string;
      if (role === "parent") {
        if (!cur.caption) throw new Error("listing has no caption — cannot recreate carousel");
        newId = await meta.createCarouselContainer(cur.publish.container_ids, cur.caption);
        await deps.saveListing(listingId, {
          publish: {
            parent_container_id: newId,
            container_status: { [newId]: "IN_PROGRESS" },
            attempts,
          },
        });
      } else {
        const idx = cur.publish.container_ids.indexOf(containerId);
        if (idx === -1) throw new Error(`container ${containerId} not in container_ids`);
        const slidePath = `slides/${listingId}/${idx}.jpg`;
        const url = await deps.signedUrl(slidePath, 4); // fresh 4h URL per plan §1.4
        const isSingle = cur.publish.container_ids.length === 1;
        newId = isSingle
          ? await meta.createImageContainer(url, { caption: cur.caption ?? "" })
          : await meta.createImageContainer(url, { isCarouselItem: true });
        const nextIds = [...cur.publish.container_ids];
        nextIds[idx] = newId;
        await deps.saveListing(listingId, {
          publish: {
            container_ids: nextIds,
            container_status: { [newId]: "IN_PROGRESS" },
            attempts,
          },
        });
      }
      await deps.enqueuePoll(
        { kind: "poll-container", listing_id: listingId, container_id: newId, role, attempt: 0 },
        { delaySec: 30, deduplicationId: `poll:${listingId}:${newId}:0` },
      );
      await deps.appendEvent(listingId, "container_recreated", {
        old: containerId,
        new: newId,
        status,
        attempts,
      });
      log.info("poll worker: container recreated with fresh URL", {
        listing_id: listingId,
        old: containerId,
        new: newId,
      });
      return { outcome: "recreated" };
    } catch (err) {
      if (err instanceof KillSwitchEngaged) {
        await parkForKillSwitch(deps, listing);
        return { outcome: "killed" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      await failListing(deps, listing, msg);
      return { outcome: "failed", error: msg };
    }
  }

  // --- 5. IN_PROGRESS → backoff -------------------------------------------------------
  return requeueBackoff(deps, listing, payload, "in progress");
}

/** FINISHED branch: advance child → parent → media_publish. */
async function handleFinished(
  deps: WorkerDeps,
  listing: ListingDoc,
  payload: PollContainerPayload,
  meta: import("@/lib/meta").MetaClient,
): Promise<PollOutcome> {
  const { listing_id: listingId, container_id: containerId, role } = payload;
  if (role === "parent") {
    return publishNow(deps, listing, containerId);
  }
  const ids = listing.publish.container_ids;
  const isSingle = ids.length === 1 && ids[0] === containerId;
  if (isSingle) {
    return publishNow(deps, listing, containerId);
  }
  const allDone = ids.every((id) => listing.publish.container_status[id] === "FINISHED");
  if (!allDone || listing.publish.parent_container_id) {
    return { outcome: "waiting-children" };
  }
  if (!listing.caption) {
    await failListing(deps, listing, "listing has no caption — cannot create carousel");
    return { outcome: "failed", error: "missing caption" };
  }
  try {
    await liveSettings(deps);
    const parent = await meta.createCarouselContainer(ids, listing.caption);
    await deps.saveListing(listingId, {
      publish: {
        parent_container_id: parent,
        container_status: { [parent]: "IN_PROGRESS" },
      },
    });
    await deps.enqueuePoll(
      { kind: "poll-container", listing_id: listingId, container_id: parent, role: "parent", attempt: 0 },
      { delaySec: 30, deduplicationId: `poll:${listingId}:${parent}:0` },
    );
    await deps.appendEvent(listingId, "carousel_parent_created", { parent });
    log.info("poll worker: carousel parent created", { listing_id: listingId, parent });
    return { outcome: "parent-created" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failListing(deps, listing, msg);
    return { outcome: "failed", error: msg };
  }
}

async function requeueBackoff(  deps: WorkerDeps,
  listing: ListingDoc,
  payload: PollContainerPayload,
  why: string,
): Promise<PollOutcome> {
  const attempt = payload.attempt + 1;
  if (attempt > MAX_POLL_ATTEMPTS) {
    await failListing(deps, listing, `container polling timed out after ${attempt} attempts (${why})`);
    return { outcome: "failed", error: "poll timeout" };
  }
  const delaySec = Math.min(30 * 2 ** payload.attempt, 300);
  await deps.enqueuePoll(
    { ...payload, attempt },
    { delaySec, deduplicationId: `poll:${payload.listing_id}:${payload.container_id}:${attempt}` },
  );
  log.info("poll worker: requeued with backoff", {
    listing_id: payload.listing_id,
    attempt,
    delaySec,
  });
  return { outcome: "requeued" };
}

/**
 * Publish a FINISHED container. media_publish is called AT MOST ONCE per
 * listing: success stores media_id immediately, so any retry/recovery takes
 * the idempotent getPermalink path instead of calling media_publish again.
 */
async function publishNow(
  deps: WorkerDeps,
  listing: ListingDoc,
  containerId: string,
): Promise<PollOutcome> {
  const listingId = listing.id;
  const meta = deps.getMeta();

  const settings = await liveSettings(deps); // throws KillSwitchEngaged → caller parks
  if (settings.publish_mode === "dry_run") {
    log.info("dry_run: would publish — skipping media_publish", {
      listing_id: listingId,
      container_id: containerId,
    });
    await deps.saveListing(listingId, {
      status: "PUBLISHED",
      publish: { ...listing.publish, permalink: null, last_error: "dry_run", locked_until: null },
    });
    await deps.appendEvent(listingId, "dry_run_complete", { container_id: containerId });
    return { outcome: "dry-run" };
  }

  let mediaId: string;
  try {
    mediaId = await meta.publishContainer(containerId);
  } catch (err) {
    // media_publish is NEVER auto-retried (duplicate-post risk): surface to
    // the admin with the container id so they can verify on the IG profile
    // before any manual retry.
    const msg = err instanceof Error ? err.message : String(err);
    await failListing(deps, listing, `media_publish failed for container ${containerId}: ${msg}`);
    return { outcome: "failed", error: msg };
  }
  // media_id persisted BEFORE the permalink fetch — a crash here recovers via
  // getPermalink, never via a second media_publish.
  await deps.saveListing(listingId, { publish: { ...listing.publish, media_id: mediaId } });

  const permalink = await meta.getPermalink(mediaId);
  return finalizePublished(deps, listing, mediaId, permalink);
}

/** Shared finalize: mark PUBLISHED, bump counters, DM the seller. */
async function finalizePublished(
  deps: WorkerDeps,
  listing: ListingDoc,
  mediaId: string,
  permalink?: string,
): Promise<PollOutcome> {
  const listingId = listing.id;
  let link = permalink;
  if (!link) {
    link = await deps.getMeta().getPermalink(mediaId);
  }
  const now = deps.now();
  const settings = await deps.getSettings();
  await deps.recordPublish(tzDay(now, settings.posting_window.tz), now);
  const fresh = (await deps.getListing(listingId)) ?? listing;
  await deps.saveListing(listingId, {
    status: "PUBLISHED",
    publish: { ...fresh.publish, media_id: mediaId, permalink: link, last_error: null, locked_until: null },
  });
  await deps.appendEvent(listingId, "published", { media_id: mediaId, permalink: link });
  try {
    await deps.getMeta().sendMessage(listing.seller_igsid, { text: SELLER_PUBLISHED_DM(link) });
  } catch (dmErr) {
    if (isWindowError(dmErr)) {
      log.info("published DM skipped — 24h window closed", { listing_id: listingId });
    } else {
      log.warn("published DM failed", {
        listing_id: listingId,
        error: dmErr instanceof Error ? dmErr.message : String(dmErr),
      });
    }
  }
  log.info("listing PUBLISHED", { listing_id: listingId, permalink: link });
  return { outcome: "published", permalink: link };
}

function isMetaSubcode(err: unknown, subcode: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "subcode" in err &&
    (err as { subcode?: number }).subcode === subcode
  );
}

function isWindowError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "isWindowError" in err &&
    typeof (err as { isWindowError?: unknown }).isWindowError === "function" &&
    (err as unknown as MetaApiError).isWindowError()
  );
}
