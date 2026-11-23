/**
 * Worker idempotency tests — fake in-memory deps (no Firebase, no Meta).
 * The headline case: duplicate delivery of publish + poll payloads results in
 * EXACTLY ONE media_publish call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/images", () => ({
  processSlide: async () => Buffer.from("processed"),
}));

import { blankListingDoc } from "@/lib/db";
import { handlePublish } from "./publish";
import { handlePollContainer } from "./poll-container";
import type { WorkerDeps } from "./common";
import type {
  AdminSettings,
  ListingDoc,
  PollContainerPayload,
} from "@/lib/types";
import { MetaApiError, type ContainerStatus, type MetaClient } from "@/lib/meta";

function deepMerge(target: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) return patch;
  if (
    patch !== null &&
    typeof patch === "object" &&
    target !== null &&
    typeof target === "object" &&
    !Array.isArray(target)
  ) {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (v !== undefined) out[k] = deepMerge(out[k], v);
    }
    return out;
  }
  return patch;
}

interface FakeMeta extends MetaClient {
  calls: { mediaPublish: number; createImage: number; createCarousel: number; quota: number; send: number };
  quota: { quota_usage: number; quota_total: number };
  statusFor: (id: string) => ContainerStatus;
  failPublishWith?: MetaApiError | undefined;
}

interface FakeState {
  listings: Map<string, ListingDoc>;
  settings: AdminSettings;
  polls: PollContainerPayload[];
  publishes: { listingId: string; notBefore: Date }[];
  notifications: string[];
  dms: { igsid: string; text: string }[];
  postsToday: number;
  lastPublish: Date | null;
  meta: FakeMeta;
  nowIso: string;
}

function makeMeta(get: () => FakeState): FakeMeta {
  let n = 0;
  const calls = { mediaPublish: 0, createImage: 0, createCarousel: 0, quota: 0, send: 0 };
  const quota = { quota_usage: 0, quota_total: 100 };
  const self: FakeMeta = {
    calls,
    quota,
    statusFor: (_id: string): ContainerStatus => "FINISHED",
    failPublishWith: undefined,
    async sendMessage(igsid: string, opts: { text?: string }) {
      calls.send++;
      get().dms.push({ igsid, text: opts.text ?? "" });
      return { messageId: "m1" };
    },
    async createImageContainer(_url: string, _opts?: { isCarouselItem?: boolean; caption?: string }) {
      calls.createImage++;
      return `child_${n++}`;
    },
    async createCarouselContainer(_children: string[], _caption: string) {
      calls.createCarousel++;
      return "parent_0";
    },
    async getContainerStatus(id: string) {
      return self.statusFor(id);
    },
    async publishContainer(_id: string) {
      if (self.failPublishWith) throw self.failPublishWith;
      calls.mediaPublish++;
      return "media_1";
    },
    async getPermalink(_id: string) {
      return "https://www.instagram.com/p/abc/";
    },
    async getPublishingLimit() {
      calls.quota++;
      return { ...self.quota };
    },
  };
  return self;
}

function makeSettings(over: Partial<AdminSettings> = {}): AdminSettings {
  return {
    global_kill_switch: false,
    publish_mode: "auto",
    max_posts_per_day: 6,
    min_gap_minutes: 90,
    posting_window: { start: "12:00", end: "23:00", tz: "Asia/Karachi" },
    max_listings_per_seller_per_day: 5,
    photo_debounce_seconds: 25,
    retention_days: 30,
    caption_cta: "dm",
    cover_slide_enabled: false,
    faq_buyer: "",
    ig_user_id: "17841400000000001",
    token: null,
    token_health: "missing",
    ...over,
  };
}

function makeListing(): ListingDoc {
  const doc = blankListingDoc("lst1", "seller1", new Date().toISOString());
  doc.status = "SUBMITTED";
  doc.caption = "Test listing caption #prelovedpakistan";
  const now = new Date().toISOString();
  doc.photos = [
    { storage_path: "raw/lst1/a.jpg", w: 100, h: 100, phash: "a".repeat(16), received_at: now },
    { storage_path: "raw/lst1/b.jpg", w: 100, h: 100, phash: "b".repeat(16), received_at: now },
  ];
  return doc;
}

function makeState(over: Partial<FakeState> = {}): FakeState {
  let state!: FakeState;
  const meta = makeMeta(() => state);
  state = {
    listings: new Map(),
    settings: makeSettings(),
    polls: [],
    publishes: [],
    notifications: [],
    dms: [],
    postsToday: 0,
    lastPublish: null,
    meta,
    nowIso: "2026-09-30T10:00:00Z", // 15:00 PKT — inside the window
    ...over,
  };
  state.listings.set("lst1", makeListing());
  return state;
}

function makeDeps(state: FakeState): WorkerDeps {
  return {
    now: () => new Date(state.nowIso),
    claimListing: async (id) => {
      const doc = state.listings.get(id);
      if (!doc) return null;
      const preStatus = doc.status;
      if (doc.status === "PUBLISHED") return { doc, claimed: false, alreadyPublished: true, preStatus };
      if (doc.publish.media_id) return { doc, claimed: false, alreadyPublished: false, preStatus };
      if (["SUBMITTED", "APPROVED", "QUEUED"].includes(doc.status)) {
        const next: ListingDoc = {
          ...doc,
          status: "PUBLISHING",
          publish: { ...doc.publish, locked_until: new Date(Date.now() + 600_000).toISOString() },
        };
        state.listings.set(id, next);
        return { doc: next, claimed: true, alreadyPublished: false, preStatus };
      }
      return { doc, claimed: false, alreadyPublished: false, preStatus };
    },
    getListing: async (id) => state.listings.get(id) ?? null,
    saveListing: async (id, patch) => {
      const cur = state.listings.get(id);
      if (!cur) throw new Error("missing listing");
      state.listings.set(id, deepMerge(cur, patch) as ListingDoc);
    },
    appendEvent: async () => {},
    getSettings: async () => state.settings,
    getPostsToday: async () => state.postsToday,
    getLastPublish: async () => state.lastPublish,
    recordPublish: async (_day, at) => {
      state.postsToday++;
      state.lastPublish = at;
    },
    download: async () => Buffer.from("raw"),
    upload: async () => {},
    signedUrl: async () => "https://example.com/signed.jpg",
    processImage: async () => Buffer.from("processed"),
    getMeta: () => state.meta,
    enqueuePublish: async (listingId, opts) => {
      state.publishes.push({ listingId, notBefore: opts.notBefore });
    },
    enqueuePoll: async (p) => {
      state.polls.push(p);
    },
    notify: async (text) => {
      state.notifications.push(text);
    },
  };
}

describe("idempotency — duplicate deliveries publish exactly once", () => {
  let state: FakeState;
  let deps: WorkerDeps;
  beforeEach(() => {
    state = makeState();
    deps = makeDeps(state);
  });

  async function runFullFlow(): Promise<void> {
    const r1 = await handlePublish("lst1", deps);
    expect(r1.outcome).toBe("containers-created");
    expect(state.polls).toHaveLength(2);
    const [c1, c2] = state.polls as [PollContainerPayload, PollContainerPayload];
    expect(await handlePollContainer(c1!, deps)).toMatchObject({ outcome: "waiting-children" });
    expect(await handlePollContainer(c2!, deps)).toMatchObject({ outcome: "parent-created" });
    expect(state.polls).toHaveLength(3);
    const parent = state.polls[2]!;
    expect(parent.role).toBe("parent");
    expect(await handlePollContainer(parent, deps)).toMatchObject({ outcome: "published" });
  }

  it("publish + polls delivered twice → single media_publish", async () => {
    await runFullFlow();
    expect(state.meta.calls.mediaPublish).toBe(1);
    const listing = state.listings.get("lst1")!;
    expect(listing.status).toBe("PUBLISHED");
    expect(listing.publish.permalink).toBe("https://www.instagram.com/p/abc/");
    expect(state.postsToday).toBe(1);
    expect(state.dms).toHaveLength(1); // seller permalink DM

    // Duplicate delivery of every payload (QStash redelivery / double enqueue).
    const dup = await handlePublish("lst1", deps);
    expect(dup.outcome).toBe("already-published");
    for (const p of state.polls.slice(0, 3)) {
      const r = await handlePollContainer({ ...p }, deps);
      expect(r.outcome).toBe("already-published");
    }
    expect(state.meta.calls.mediaPublish).toBe(1);
    expect(state.dms).toHaveLength(1);
  });

  it("crash between media_publish and the PUBLISHED write recovers without a second media_publish", async () => {
    const listing = state.listings.get("lst1")!;
    listing.status = "PUBLISHING";
    listing.publish.media_id = "media_1";
    listing.publish.permalink = null;

    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("recovered");
    expect(state.meta.calls.mediaPublish).toBe(0);
    const after = state.listings.get("lst1")!;
    expect(after.status).toBe("PUBLISHED");
    expect(after.publish.permalink).toBe("https://www.instagram.com/p/abc/");
  });

  it("second publish worker cannot claim while the first holds the lease", async () => {
    const r1 = await handlePublish("lst1", deps);
    expect(r1.outcome).toBe("containers-created");
    // Simulate the first worker crashing mid-flight WITHOUT clearing the lease:
    // a concurrent duplicate delivery sees PUBLISHING + fresh lease → not claimed.
    const deps2 = makeDeps(state);
    deps2.claimListing = async (id) => {
      const doc = state.listings.get(id)!;
      return { doc, claimed: false, alreadyPublished: false, preStatus: doc.status };
    };
    const r2 = await handlePublish("lst1", deps2);
    expect(r2.outcome).toBe("not-claimed");
    expect(state.meta.calls.createImage).toBe(2); // no duplicate containers
  });
});

describe("gates", () => {
  it("review mode parks SUBMITTED as QUEUED without touching Meta", async () => {
    const state = makeState({ settings: makeSettings({ publish_mode: "review" }) });
    const deps = makeDeps(state);
    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("queued-review");
    expect(state.listings.get("lst1")!.status).toBe("QUEUED");
    expect(state.meta.calls.createImage).toBe(0);
    expect(state.meta.calls.quota).toBe(0);
  });

  it("review mode lets APPROVED listings through", async () => {
    const state = makeState({ settings: makeSettings({ publish_mode: "review" }) });
    const listing = state.listings.get("lst1")!;
    listing.status = "APPROVED";
    const deps = makeDeps(state);
    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("containers-created");
  });

  it("kill switch parks before any Meta call", async () => {
    const state = makeState({ settings: makeSettings({ global_kill_switch: true }) });
    const deps = makeDeps(state);
    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("killed");
    expect(state.meta.calls.quota).toBe(0);
    expect(state.meta.calls.createImage).toBe(0);
    expect(state.notifications.some((t) => t.includes("Kill switch"))).toBe(true);
    expect(state.listings.get("lst1")!.publish.last_error).toBe("killed");
  });

  it("future slot re-enqueues with notBefore", async () => {
    const state = makeState();
    state.nowIso = "2026-09-30T05:00:00Z"; // 10:00 PKT — before the window
    const deps = makeDeps(state);
    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("scheduled");
    expect(r.slot_at).toBe("2026-09-30T07:00:00.000Z");
    expect(state.publishes).toHaveLength(1);
    expect(state.publishes[0]!.notBefore.toISOString()).toBe("2026-09-30T07:00:00.000Z");
    expect(state.listings.get("lst1")!.status).toBe("QUEUED");
    expect(state.meta.calls.createImage).toBe(0);
  });

  it("exhausted Meta quota reschedules to tomorrow 12:00 PKT", async () => {
    const state = makeState();
    state.meta.quota = { quota_usage: 100, quota_total: 100 };
    const deps = makeDeps(state);
    const r = await handlePublish("lst1", deps);
    expect(r.outcome).toBe("quota-exhausted");
    expect(state.publishes[0]!.notBefore.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(state.listings.get("lst1")!.status).toBe("QUEUED");
    expect(state.meta.calls.createImage).toBe(0);
    expect(state.notifications.some((t) => t.includes("quota exhausted"))).toBe(true);
  });

  it("dry_run completes without media_publish, permalink null, last_error dry_run", async () => {
    const state = makeState({ settings: makeSettings({ publish_mode: "dry_run" }) });
    const deps = makeDeps(state);
    const r1 = await handlePublish("lst1", deps);
    expect(r1.outcome).toBe("containers-created");
    const [c1, c2] = state.polls as [PollContainerPayload, PollContainerPayload];
    await handlePollContainer(c1!, deps);
    await handlePollContainer(c2!, deps);
    const parent = state.polls[2]!;
    const r = await handlePollContainer(parent, deps);
    expect(r.outcome).toBe("dry-run");
    expect(state.meta.calls.mediaPublish).toBe(0);
    const listing = state.listings.get("lst1")!;
    expect(listing.status).toBe("PUBLISHED");
    expect(listing.publish.permalink).toBeNull();
    expect(listing.publish.last_error).toBe("dry_run");
  });
});

describe("poll-container recovery", () => {
  it("ERROR container is recreated with a fresh signed URL", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const r1 = await handlePublish("lst1", deps);
    expect(r1.outcome).toBe("containers-created");
    const [c1] = state.polls as [PollContainerPayload];
    state.meta.statusFor = (id) => (id === c1!.container_id ? "ERROR" : "FINISHED");
    const r = await handlePollContainer(c1!, deps);
    expect(r.outcome).toBe("recreated");
    expect(state.meta.calls.createImage).toBe(3); // 2 originals + 1 recreation
    const listing = state.listings.get("lst1")!;
    expect(listing.publish.attempts).toBe(1);
    // New container is tracked and polled.
    const newPoll = state.polls[state.polls.length - 1]!;
    expect(listing.publish.container_ids).toContain(newPoll.container_id);
  });

  it("container ERROR beyond 3 attempts → FAILED + alert + neutral seller DM", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const listing = state.listings.get("lst1")!;
    listing.status = "PUBLISHING";
    listing.publish.container_ids = ["child_0"];
    listing.publish.container_status = { child_0: "ERROR" };
    listing.publish.attempts = 3;
    state.meta.statusFor = () => "ERROR";
    const r = await handlePollContainer(
      { kind: "poll-container", listing_id: "lst1", container_id: "child_0", role: "child", attempt: 0 },
      deps,
    );
    expect(r.outcome).toBe("failed");
    const after = state.listings.get("lst1")!;
    expect(after.status).toBe("FAILED");
    expect(state.notifications.some((t) => t.includes("failed"))).toBe(true);
    expect(state.dms).toHaveLength(1); // neutral failure DM
    expect(state.meta.calls.createImage).toBe(0); // no more recreations
  });

  it("IN_PROGRESS backs off; attempt > 8 → FAILED", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const listing = state.listings.get("lst1")!;
    listing.status = "PUBLISHING";
    listing.publish.container_ids = ["child_0"];
    state.meta.statusFor = () => "IN_PROGRESS";
    const payload: PollContainerPayload = {
      kind: "poll-container",
      listing_id: "lst1",
      container_id: "child_0",
      role: "child",
      attempt: 8,
    };
    const r = await handlePollContainer(payload, deps);
    expect(r.outcome).toBe("failed");
    expect(state.listings.get("lst1")!.status).toBe("FAILED");
  });

  it("IN_PROGRESS requeues with exponential backoff capped at 300s", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const listing = state.listings.get("lst1")!;
    listing.status = "PUBLISHING";
    listing.publish.container_ids = ["child_0"];
    state.meta.statusFor = () => "IN_PROGRESS";
    const payload: PollContainerPayload = {
      kind: "poll-container",
      listing_id: "lst1",
      container_id: "child_0",
      role: "child",
      attempt: 2,
    };
    const before = state.polls.length;
    const r = await handlePollContainer(payload, deps);
    expect(r.outcome).toBe("requeued");
    expect(state.polls.length).toBe(before + 1); // re-enqueued with bumped attempt
    const last = state.polls[state.polls.length - 1]!;
    expect(last.attempt).toBe(3);
  });

  it("subcode 2207027 (still processing) keeps polling instead of recreating", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const listing = state.listings.get("lst1")!;
    listing.status = "PUBLISHING";
    listing.publish.container_ids = ["child_0"];
    const err = new MetaApiError("still processing", 100, 2207027, 400);
    state.meta.getContainerStatus = async () => {
      throw err;
    };
    const r = await handlePollContainer(
      { kind: "poll-container", listing_id: "lst1", container_id: "child_0", role: "child", attempt: 0 },
      deps,
    );
    expect(r.outcome).toBe("requeued");
    expect(state.meta.calls.createImage).toBe(0);
  });

  it("single-photo listing publishes the child container directly (no carousel)", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const listing = state.listings.get("lst1")!;
    listing.photos = listing.photos.slice(0, 1);
    const r1 = await handlePublish("lst1", deps);
    expect(r1.outcome).toBe("containers-created");
    expect(state.meta.calls.createCarousel).toBe(0);
    const [c1] = state.polls as [PollContainerPayload];
    const r = await handlePollContainer(c1!, deps);
    expect(r.outcome).toBe("published");
    expect(state.meta.calls.mediaPublish).toBe(1);
    expect(state.meta.calls.createCarousel).toBe(0);
  });
});
