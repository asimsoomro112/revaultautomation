/**
 * Reconcile decision guards (2026-11-24 audit HIGH #3): a stuck
 * PUBLISHING listing may only be marked FAILED when it has no media_id,
 * no live claim lease, and no recent worker activity.
 */
import { describe, expect, it } from "vitest";
import { hasLiveClaimLease, reconcileDecision, STUCK_AFTER_MS } from "./reconcile";

const NOW = Date.parse("2026-11-26T09:00:00.000Z");
const OLD = new Date(NOW - STUCK_AFTER_MS - 3600_000).toISOString();
const RECENT = new Date(NOW - 60_000).toISOString();
const LEASE_LIVE = new Date(NOW + 5 * 60_000).toISOString();
const LEASE_EXPIRED = new Date(NOW - 5 * 60_000).toISOString();

function input(over: Partial<Parameters<typeof reconcileDecision>[0]> = {}) {
  return {
    status: "PUBLISHING",
    created_at: OLD,
    publish: { locked_until: null, media_id: null },
    lastActivity: null,
    ...over,
  };
}

describe("hasLiveClaimLease", () => {
  it("is true only for a future lease", () => {
    expect(hasLiveClaimLease({ locked_until: LEASE_LIVE }, NOW)).toBe(true);
    expect(hasLiveClaimLease({ locked_until: LEASE_EXPIRED }, NOW)).toBe(false);
    expect(hasLiveClaimLease({ locked_until: null }, NOW)).toBe(false);
    expect(hasLiveClaimLease({ locked_until: "not-a-date" }, NOW)).toBe(false);
  });
});

describe("reconcileDecision", () => {
  it("fails a stuck PUBLISHING listing with no lease, no media, no recent activity", () => {
    expect(reconcileDecision(input(), NOW)).toBe("fail");
  });

  it("skips when the claim lease is live (worker holds the listing)", () => {
    expect(
      reconcileDecision(input({ publish: { locked_until: LEASE_LIVE, media_id: null } }), NOW),
    ).toBe("skip-lease");
  });

  it("fails when the claim lease has expired", () => {
    expect(
      reconcileDecision(input({ publish: { locked_until: LEASE_EXPIRED, media_id: null } }), NOW),
    ).toBe("fail");
  });

  it("routes a media_id listing with an expired lease to recovery, never FAILED", () => {
    expect(
      reconcileDecision(
        input({ publish: { locked_until: LEASE_EXPIRED, media_id: "media_1" } }),
        NOW,
      ),
    ).toBe("recover-live-media");
  });

  it("leaves a media_id listing alone while its lease is live (winner finishing)", () => {
    expect(
      reconcileDecision(input({ publish: { locked_until: LEASE_LIVE, media_id: "media_1" } }), NOW),
    ).toBe("skip-live-media");
  });

  it("skips when worker activity is recent", () => {
    expect(reconcileDecision(input({ lastActivity: RECENT }), NOW)).toBe("skip-recent");
  });

  it("skips when the listing is no longer PUBLISHING (concurrent move wins)", () => {
    expect(reconcileDecision(input({ status: "REJECTED" }), NOW)).toBe("skip-not-publishing");
    expect(reconcileDecision(input({ status: "PUBLISHED" }), NOW)).toBe("skip-not-publishing");
  });
});
