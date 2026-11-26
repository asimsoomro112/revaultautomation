/**
 * Reconcile cron route tests (2026-11-24 audit HIGH #3): the route must
 * honour the claim lease + media_id and only fail a listing that is
 * still stuck inside the transaction's fresh read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  listings: new Map<string, Record<string, unknown>>(),
  events: new Map<string, Array<{ at: string }>>(),
  appendListingEvent: vi.fn(async () => {}),
  notifyAdmin: vi.fn(async () => {}),
  enqueuePublishWorker: vi.fn(async () => true),
}));

vi.mock("@/lib/cron-auth", () => ({ isCronAuthorized: () => true }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/telegram", () => ({ notifyAdmin: mocks.notifyAdmin }));
vi.mock("@/lib/publish-queue", () => ({ enqueuePublishWorker: mocks.enqueuePublishWorker }));
vi.mock("@/lib/firebase-admin", () => {
  function applyPatch(id: string, patch: Record<string, unknown>) {
    const cur = mocks.listings.get(id);
    if (!cur) throw new Error(`fake listings doc(${id}) missing`);
    const next: Record<string, unknown> = { ...cur };
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      if (parts.length === 1) {
        next[key] = value;
        continue;
      }
      let target = next;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i]!;
        const existing = target[p];
        const obj =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};
        target[p] = obj;
        target = obj;
      }
      target[parts[parts.length - 1]!] = value;
    }
    mocks.listings.set(id, next);
  }
  function makeRef(id: string) {
    return {
      id,
      path: `listings/${id}`,
      collection: (_sub: string) => ({
        orderBy: (_f: string, _d: string) => ({
          limit: (_n: number) => ({ __eventsFor: id }),
        }),
      }),
    };
  }
  const tx = {
    get: async (arg: { id?: string; __eventsFor?: string }) => {
      if (arg.__eventsFor) {
        const evs = [...(mocks.events.get(arg.__eventsFor) ?? [])].sort((a, b) =>
          b.at.localeCompare(a.at),
        );
        return { docs: evs.slice(0, 1).map((e) => ({ data: () => e })) };
      }
      const id = arg.id!;
      return {
        exists: mocks.listings.has(id),
        data: () => mocks.listings.get(id),
        ref: makeRef(id),
      };
    },
    update: (ref: { id: string }, patch: Record<string, unknown>) => {
      applyPatch(ref.id, patch);
      return tx;
    },
  };
  const fakeDb = {
    collection: (_name: string) => {
      const query = {
        where: (_f: string, _op: string, _v: unknown) => query,
        get: async () => ({
          size: mocks.listings.size,
          docs: [...mocks.listings.entries()].map(([id, d]) => ({
            id,
            data: () => d,
            ref: makeRef(id),
          })),
        }),
      };
      return query;
    },
    runTransaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  return { adminDb: () => fakeDb, appendListingEvent: mocks.appendListingEvent };
});

import { GET } from "@/app/api/cron/reconcile/route";

const HOUR = 3600_000;
const old = () => new Date(Date.now() - 3 * HOUR).toISOString();
const leaseLive = () => new Date(Date.now() + 5 * 60_000).toISOString();
const leaseExpired = () => new Date(Date.now() - 5 * 60_000).toISOString();

function stuck(over: Record<string, unknown> = {}) {
  return {
    status: "PUBLISHING",
    created_at: old(),
    publish: { locked_until: null, media_id: null, permalink: null, attempts: 0, last_error: null },
    ...over,
  };
}

function req() {
  return new NextRequest("http://localhost/api/cron/reconcile");
}

beforeEach(() => {
  mocks.listings.clear();
  mocks.events.clear();
  vi.clearAllMocks();
  mocks.enqueuePublishWorker.mockResolvedValue(true);
});

describe("GET /api/cron/reconcile", () => {
  it("marks a stuck PUBLISHING listing FAILED", async () => {
    mocks.listings.set("lst_stuck", stuck());
    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { recovered: string[] };
    expect(data.recovered).toEqual(["lst_stuck"]);
    expect(mocks.listings.get("lst_stuck")).toMatchObject({ status: "FAILED" });
    expect(mocks.appendListingEvent).toHaveBeenCalledWith(
      "lst_stuck",
      "publish_failed",
      expect.anything(),
    );
  });

  it("does not fail a listing holding a live claim lease", async () => {
    mocks.listings.set(
      "lst_leased",
      stuck({ publish: { locked_until: leaseLive(), media_id: null, permalink: null, attempts: 0, last_error: null } }),
    );
    const res = await GET(req());
    const data = (await res.json()) as { recovered: string[]; skipped_lease: string[] };
    expect(data.recovered).toEqual([]);
    expect(data.skipped_lease).toEqual(["lst_leased"]);
    expect(mocks.listings.get("lst_leased")).toMatchObject({ status: "PUBLISHING" });
    expect(mocks.appendListingEvent).not.toHaveBeenCalled();
  });

  it("routes a media_id listing to recovery instead of FAILED", async () => {
    mocks.listings.set(
      "lst_live",
      stuck({ publish: { locked_until: leaseExpired(), media_id: "media_1", permalink: null, attempts: 1, last_error: null } }),
    );
    const res = await GET(req());
    const data = (await res.json()) as {
      recovered: string[];
      live_media: string[];
      recovery_enqueued: string[];
    };
    expect(data.recovered).toEqual([]);
    expect(data.live_media).toEqual(["lst_live"]);
    expect(data.recovery_enqueued).toEqual(["lst_live"]);
    expect(mocks.listings.get("lst_live")).toMatchObject({ status: "PUBLISHING" });
    expect(mocks.enqueuePublishWorker).toHaveBeenCalledWith("lst_live");
  });

  it("leaves a media_id listing alone while its lease is live", async () => {
    mocks.listings.set(
      "lst_live_leased",
      stuck({ publish: { locked_until: leaseLive(), media_id: "media_1", permalink: null, attempts: 1, last_error: null } }),
    );
    const res = await GET(req());
    const data = (await res.json()) as { live_media: string[]; recovery_enqueued: string[] };
    expect(data.live_media).toEqual(["lst_live_leased"]);
    expect(data.recovery_enqueued).toEqual([]);
    expect(mocks.enqueuePublishWorker).not.toHaveBeenCalled();
    expect(mocks.listings.get("lst_live_leased")).toMatchObject({ status: "PUBLISHING" });
  });

  it("does not fail a listing with recent worker activity", async () => {
    mocks.listings.set("lst_active", stuck());
    mocks.events.set("lst_active", [{ at: new Date(Date.now() - 60_000).toISOString() }]);
    const res = await GET(req());
    const data = (await res.json()) as { recovered: string[] };
    expect(data.recovered).toEqual([]);
    expect(mocks.listings.get("lst_active")).toMatchObject({ status: "PUBLISHING" });
  });
});
