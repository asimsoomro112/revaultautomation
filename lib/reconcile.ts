/**
 * Reconcile decision logic — pure, so the cron route's guards are unit
 * tested without a Firestore fake.
 *
 * A PUBLISHING listing may only be marked FAILED when ALL of these hold:
 *  - it is still PUBLISHING (a concurrent worker/admin move wins),
 *  - it has no media_id (media_id set = the post is live on IG; failing
 *    it would mark a live post FAILED — audit HIGH #3),
 *  - its claim lease (publish.locked_until) is not live (a live lease
 *    means a worker holds the listing right now — audit HIGH #3),
 *  - no worker activity (latest audit event) inside the stuck window.
 *
 * A media_id listing with an expired lease is routed to permalink
 * recovery (the publish worker's media_id path) instead of FAILED.
 */

export const STUCK_AFTER_MS = 2 * 3600 * 1000;

export type ReconcileDecision =
  | "fail"
  | "recover-live-media"
  | "skip-live-media"
  | "skip-lease"
  | "skip-recent"
  | "skip-not-publishing";

export interface ReconcileInput {
  status: string;
  created_at: string;
  publish: { locked_until: string | null; media_id: string | null };
  lastActivity: string | null;
}

/** True when the claim lease exists and has not yet expired. */
export function hasLiveClaimLease(
  publish: { locked_until: string | null },
  nowMs: number,
): boolean {
  if (!publish.locked_until) return false;
  const lockMs = Date.parse(publish.locked_until);
  return !Number.isNaN(lockMs) && lockMs > nowMs;
}

export function reconcileDecision(input: ReconcileInput, nowMs: number): ReconcileDecision {
  if (input.status !== "PUBLISHING") return "skip-not-publishing";
  const leaseLive = hasLiveClaimLease(input.publish, nowMs);
  if (input.publish.media_id) {
    // Live on IG: never FAILED. With an expired lease, hand it to the
    // publish worker's permalink recovery; with a live lease, the winner
    // is still finishing — leave it alone.
    return leaseLive ? "skip-live-media" : "recover-live-media";
  }
  if (leaseLive) return "skip-lease";
  const anchorMs = Date.parse(input.lastActivity ?? input.created_at);
  if (!Number.isNaN(anchorMs) && anchorMs >= nowMs - STUCK_AFTER_MS) {
    return "skip-recent";
  }
  return "fail";
}
