/**
 * Admin API tests — the 5-feature endpoints added 2026-11-23:
 * POST /api/admin/settings, GET /api/admin/activity,
 * GET /api/admin/sellers/banned, POST /api/admin/sellers/:igsid/unban.
 *
 * Firestore is faked at the adminDb() surface (collection / collectionGroup /
 * doc); auth is faked at authorizeAdmin. No network, no real Firebase.
 * All mock state lives in one vi.hoisted() block (vi.mock factories are
 * hoisted, so they may only reference hoisted values).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeDb } from "@/lib/test-fakes";

const mocks = vi.hoisted(() => {
  const settings = {
    global_kill_switch: false,
    publish_mode: "review",
    max_posts_per_day: 3,
    min_gap_minutes: 60,
    posting_window: { start: "09:00", end: "22:00", tz: "Asia/Karachi" },
    max_listings_per_seller_per_day: 5,
    photo_debounce_seconds: 90,
    retention_days: 30,
    caption_cta: "dm",
    cover_slide_enabled: false,
    faq_buyer: "FAQ: DM to buy",
    ig_user_id: "17841400008460056",
    token: null,
    token_health: "missing",
  };
  return {
    authOk: true,
    settings,
    blocklist: new Map<string, { reason: string; at: string; by: string }>(),
    conversations: new Map<string, Record<string, unknown>>(),
    listings: [] as Array<{ id: string; created_at: string }>,
    listingById: new Map<string, Record<string, unknown>>(),
    events: [] as Array<{
      id: string;
      listingId: string;
      data: { type: string; at: string; by?: string | null; detail?: string | null; photo_count?: number; error?: string; attempt?: number };
    }>,
    getAdminSettings: vi.fn(async () => settings),
    updateAdminSettings: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(settings, patch);
    }),
    appendListingEvent: vi.fn(async () => {}),
    notifyAdmin: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/admin-auth", () => ({
  authorizeAdmin: vi.fn(async () => {
    if (mocks.authOk) {
      return {
        ok: true,
        principal: { uid: "admin-1", email: "admin@test", via: "claim" as const },
      };
    }
    return { ok: false, status: 401 as const, error: "Unauthorized" };
  }),
}));

vi.mock("@/lib/firebase-admin", () => {
  function orderLimitGet<T extends { id: string; data: () => unknown }>(
    docs: T[],
    sortKey: (d: T) => string,
  ) {
    return {
      orderBy: (_f: string, _d: string) => ({
        limit: (_n: number) => ({
          get: async () => ({
            docs: [...docs].sort((a, b) => sortKey(b).localeCompare(sortKey(a))),
          }),
        }),
      }),
    };
  }
  const fakeDb = {
    collection: (name: string) => {
      if (name === "blocklist") {
        return orderLimitGet(
          [...mocks.blocklist.entries()].map(([id, data]) => ({ id, data: () => data })),
          (d) => (d.data() as { at: string }).at,
        );
      }
      if (name === "listings") {
        return {
          ...orderLimitGet(
            mocks.listings.map((l) => ({
              id: l.id,
              data: () => ({ created_at: l.created_at }),
              ref: {
                collection: (sub: string) => {
                  if (sub !== "events") throw new Error(`fakeDb listings ref.collection(${sub}) not stubbed`);
                  return orderLimitGet(
                    mocks.events
                      .filter((e) => e.listingId === l.id)
                      .map((e) => ({ id: e.id, data: () => e.data })),
                    (d) => (d.data() as { at: string }).at,
                  );
                },
              },
            })),
            (d) => (d.data() as { created_at: string }).created_at,
          ),
          // Doc-level access for the approve/reject/caption/retry endpoints.
          doc: (id: string) => ({
            get: async () => ({
              exists: mocks.listingById.has(id),
              data: () => mocks.listingById.get(id),
            }),
            update: async (patch: Record<string, unknown>) => {
              const cur = mocks.listingById.get(id);
              if (!cur) throw new Error(`fakeDb listings doc(${id}) missing`);
              mocks.listingById.set(id, { ...cur, ...patch });
            },
          }),
        };
      }
      throw new Error(`fakeDb.collection(${name}) not stubbed`);
    },
    // The activity endpoint must NOT use collectionGroup: it needs a
    // composite index on the events collection group, and Firestore 500s
    // until that index exists (2026-11-23: /admin/activity 500d).
    // Throw here so any future use fails the test instead of prod.
    collectionGroup: (_name: string) => {
      throw new Error("fakeDb.collectionGroup must not be called");
    },
    doc: (path: string) => {
      const parts = path.split("/");
      const coll = parts[0] ?? "";
      const id = parts[1] ?? "";
      if (coll === "blocklist") {
        return {
          get: async () => ({ exists: mocks.blocklist.has(id) }),
          delete: async () => {
            mocks.blocklist.delete(id);
          },
          set: async (data: Record<string, unknown>) => {
            mocks.blocklist.set(id, data as { reason: string; at: string; by: string });
          },
        };
      }
      if (coll === "conversations") {
        return {
          get: async () => ({ exists: mocks.conversations.has(id) }),
          set: async (patch: Record<string, unknown>) => {
            mocks.conversations.set(id, { ...mocks.conversations.get(id), ...patch });
          },
        };
      }
      throw new Error(`fakeDb.doc(${path}) not stubbed`);
    },
  };
  return {
    adminDb: () => fakeDb,
    adminAuth: () => ({}),
    getAdminSettings: mocks.getAdminSettings,
    updateAdminSettings: mocks.updateAdminSettings,
    appendListingEvent: mocks.appendListingEvent,
  };
});
vi.mock("@/lib/storage", () => ({ signedReadUrl: vi.fn(async () => "") }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ TimeZone: "Asia/Karachi", MAX_POSTS_PER_DAY: 6 }),
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/telegram", () => ({ notifyAdmin: mocks.notifyAdmin }));
vi.mock("@/lib/ig-token", () => ({
  daysUntilExpiry: vi.fn(() => 10),
  markTokenDegraded: vi.fn(async () => {}),
  refreshLongLivedToken: vi.fn(async () => ({ token: "x", expires_at: "2026-12-01" })),
  storeToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/publish-queue", () => ({
  enqueuePublishWorker: vi.fn(async () => true),
}));

import { GET, POST } from "@/app/api/admin/[[...path]]/route";

function ctx(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

function getReq(path: string) {
  return new NextRequest(`http://localhost/api/admin/${path}`);
}

function postReq(path: string, body: unknown) {
  return new NextRequest(`http://localhost/api/admin/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.authOk = true;
  mocks.blocklist.clear();
  mocks.conversations.clear();
  mocks.listings.length = 0;
  mocks.listingById.clear();
  mocks.events.length = 0;
  vi.clearAllMocks();
  // restore the shared settings object to the test-fakes defaults
  Object.assign(mocks.settings, makeFakeDb().settings);
});

describe("POST /api/admin/settings", () => {
  it("accepts a partial update and echoes the fresh settings", async () => {
    const res = await POST(postReq("settings", { max_posts_per_day: 10 }), ctx(["settings"]));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; settings: { max_posts_per_day: number } };
    expect(data.ok).toBe(true);
    expect(data.settings.max_posts_per_day).toBe(10);
    expect(mocks.updateAdminSettings).toHaveBeenCalledWith({ max_posts_per_day: 10 });
  });

  it("accepts posting_window + publish_mode together", async () => {
    const res = await POST(
      postReq("settings", {
        publish_mode: "auto",
        posting_window: { start: "10:00", end: "22:00", tz: "Asia/Karachi" },
      }),
      ctx(["settings"]),
    );
    expect(res.status).toBe(200);
    expect(mocks.updateAdminSettings).toHaveBeenCalledWith({
      publish_mode: "auto",
      posting_window: { start: "10:00", end: "22:00", tz: "Asia/Karachi" },
    });
  });

  it("rejects out-of-range values with 400", async () => {
    for (const body of [
      { max_posts_per_day: 0 },
      { max_posts_per_day: 51 },
      { publish_mode: "bogus" },
      { retention_days: 400 },
      { min_gap_minutes: -5 },
      { posting_window: { start: "25:00", end: "22:00", tz: "Asia/Karachi" } },
      { unknown_field: true },
    ]) {
      const res = await POST(postReq("settings", body), ctx(["settings"]));
      expect(res.status).toBe(400);
    }
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty body with 400", async () => {
    const res = await POST(postReq("settings", {}), ctx(["settings"]));
    expect(res.status).toBe(400);
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("returns 401 when not an admin", async () => {
    mocks.authOk = false;
    const res = await POST(postReq("settings", { max_posts_per_day: 5 }), ctx(["settings"]));
    expect(res.status).toBe(401);
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/activity", () => {
  it("returns events newest-first with the listing id and photo_count, without collectionGroup", async () => {
    mocks.listings.push(
      { id: "lst_old", created_at: "2026-11-20T09:00:00.000Z" },
      { id: "lst_new", created_at: "2026-11-23T08:00:00.000Z" },
    );
    mocks.events.push(
      { id: "e1", listingId: "lst_old", data: { type: "approved", at: "2026-11-20T10:00:00.000Z", by: "a@test", detail: "Approved in /admin" } },
      { id: "e2", listingId: "lst_new", data: { type: "finalized", at: "2026-11-23T09:00:00.000Z", by: null, detail: null, photo_count: 3 } },
      { id: "e3", listingId: "lst_new", data: { type: "finalize_retry", at: "2026-11-23T09:01:00.000Z", by: null, detail: null, error: "Gemini 503 overloaded", attempt: 1 } },
    );
    const res = await GET(getReq("activity"), ctx(["activity"]));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      items: Array<{ id: string; listing_id: string; type: string; at: string; photo_count: number | null; error: string | null; attempt: number | null }>;
    };
    expect(data.items).toHaveLength(3);
    expect(data.items[0]?.id).toBe("e3");
    expect(data.items[0]?.type).toBe("finalize_retry");
    expect(data.items[0]?.error).toBe("Gemini 503 overloaded");
    expect(data.items[0]?.attempt).toBe(1);
    expect(data.items[1]?.id).toBe("e2");
    expect(data.items[1]?.listing_id).toBe("lst_new");
    expect(data.items[1]?.type).toBe("finalized");
    expect(data.items[1]?.photo_count).toBe(3);
    expect(data.items[2]?.listing_id).toBe("lst_old");
    expect(data.items[2]?.photo_count).toBeNull();
  });
});

describe("GET /api/admin/sellers/banned", () => {
  it("returns blocklist rows newest-first", async () => {
    mocks.blocklist.set("111", { reason: "spam", at: "2026-11-20T10:00:00.000Z", by: "a@test" });
    mocks.blocklist.set("222", { reason: "abuse", at: "2026-11-23T09:00:00.000Z", by: "a@test" });
    const res = await GET(getReq("sellers/banned"), ctx(["sellers", "banned"]));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      items: Array<{ igsid: string; reason: string; at: string; by: string }>;
    };
    expect(data.items).toHaveLength(2);
    expect(data.items[0]?.igsid).toBe("222");
    expect(data.items[0]?.reason).toBe("abuse");
    expect(data.items[1]?.igsid).toBe("111");
  });
});

describe("POST /api/admin/listings/:id/reject", () => {
  it("rejects a NEEDS_REVIEW listing", async () => {
    mocks.listingById.set("lst1", { status: "NEEDS_REVIEW", seller_igsid: "111" });
    const res = await POST(
      postReq("listings/lst1/reject", { reason: "stock photo" }),
      ctx(["listings", "lst1", "reject"]),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; status: string };
    expect(data).toMatchObject({ ok: true, status: "REJECTED" });
    expect(mocks.listingById.get("lst1")).toMatchObject({ status: "REJECTED" });
  });

  it("returns 409 for a PUBLISHING listing — an in-flight publish must not be rejected", async () => {
    mocks.listingById.set("lst1", { status: "PUBLISHING", seller_igsid: "111" });
    const res = await POST(
      postReq("listings/lst1/reject", { reason: "too late" }),
      ctx(["listings", "lst1", "reject"]),
    );
    expect(res.status).toBe(409);
    expect(mocks.listingById.get("lst1")).toMatchObject({ status: "PUBLISHING" });
  });

  it("returns 409 for a PUBLISHED listing", async () => {
    mocks.listingById.set("lst1", { status: "PUBLISHED", seller_igsid: "111" });
    const res = await POST(
      postReq("listings/lst1/reject", { reason: "too late" }),
      ctx(["listings", "lst1", "reject"]),
    );
    expect(res.status).toBe(409);
    expect(mocks.listingById.get("lst1")).toMatchObject({ status: "PUBLISHED" });
  });

  it("returns 404 for a missing listing", async () => {
    const res = await POST(
      postReq("listings/nope/reject", { reason: "x" }),
      ctx(["listings", "nope", "reject"]),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/listings/:id/caption", () => {
  it("updates the caption of a CONFIRM listing", async () => {
    mocks.listingById.set("lst1", { status: "CONFIRM", caption: "old" });
    const res = await POST(
      postReq("listings/lst1/caption", { caption: "new caption" }),
      ctx(["listings", "lst1", "caption"]),
    );
    expect(res.status).toBe(200);
    expect(mocks.listingById.get("lst1")).toMatchObject({ caption: "new caption" });
  });

  it("returns 409 for a PUBLISHING listing — containers already carry the old caption", async () => {
    mocks.listingById.set("lst1", { status: "PUBLISHING", caption: "old" });
    const res = await POST(
      postReq("listings/lst1/caption", { caption: "new" }),
      ctx(["listings", "lst1", "caption"]),
    );
    expect(res.status).toBe(409);
    expect(mocks.listingById.get("lst1")).toMatchObject({ caption: "old" });
  });

  it("returns 409 for a PUBLISHED listing — the caption lives on IG now", async () => {
    mocks.listingById.set("lst1", { status: "PUBLISHED", caption: "old" });
    const res = await POST(
      postReq("listings/lst1/caption", { caption: "new" }),
      ctx(["listings", "lst1", "caption"]),
    );
    expect(res.status).toBe(409);
    expect(mocks.listingById.get("lst1")).toMatchObject({ caption: "old" });
  });

  it("returns 404 for a missing listing", async () => {
    const res = await POST(
      postReq("listings/nope/caption", { caption: "new" }),
      ctx(["listings", "nope", "caption"]),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/sellers/:igsid/unban", () => {
  it("removes the blocklist entry and unblocks the conversation", async () => {
    mocks.blocklist.set("999", { reason: "spam", at: "2026-11-23T09:00:00.000Z", by: "a@test" });
    mocks.conversations.set("999", { blocked: true });
    const res = await POST(postReq("sellers/999/unban", {}), ctx(["sellers", "999", "unban"]));
    expect(res.status).toBe(200);
    expect(mocks.blocklist.has("999")).toBe(false);
    expect(mocks.conversations.get("999")).toMatchObject({ blocked: false });
  });

  it("returns 404 when the seller is not banned", async () => {
    const res = await POST(postReq("sellers/123/unban", {}), ctx(["sellers", "123", "unban"]));
    expect(res.status).toBe(404);
  });
});
