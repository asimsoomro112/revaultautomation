/**
 * Phase 2 — handleMessage integration tests with in-memory fakes
 * (fake DbPort/Gemini/Meta/QStash/Telegram — no Firebase, no network).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleMessage, sendSafe } from "./conversation";
import {
  IGSID,
  NOW,
  blankTestExtracted,
  fullTestExtracted,
  makeFakeDeps,
  makeInbound,
  makePhoto,
  makeVisionResult,
  makeWindowError,
  type FakeDeps,
} from "./test-fakes";
import type { MessagePayload } from "./types";

let deps: FakeDeps;

function payload(mid: string): MessagePayload {
  return { kind: "message", igsid: IGSID, mid };
}

beforeEach(() => {
  deps = makeFakeDeps();
});

describe("handleMessage: IDLE routing", () => {
  it("SELLER_SUBMIT → creates listing, greets, moves to COLLECTING", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "mujhe shirt bechni hai" }), deps);

    const convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.state).toBe("COLLECTING");
    expect(convo.active_listing_id).toBeTruthy();
    const listing = deps.fdb.listings.get(convo.active_listing_id!)!;
    expect(listing.chat_text).toMatch(/shirt bechni/);
    expect(deps.meta.sent).toHaveLength(1);
    expect(convo.last_processed_mid).toBe("mid_1");
  });

  it("BUYER_QUESTION → FAQ reply, no listing created", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "BUYER_QUESTION", confidence: 0.9, lang: "en" });
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "is this available?" }), deps);

    const convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.active_listing_id).toBeNull();
    expect(deps.meta.sent).toHaveLength(1);
    expect(deps.meta.sent[0]!.opts.text).toMatch(/FAQ/);
  });

  it("OTHER → help text", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "OTHER", confidence: 0.9, lang: "roman" });
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "hello" }), deps);
    expect(deps.meta.sent).toHaveLength(1);
    expect(deps.fdb.convos.get(IGSID)!.active_listing_id).toBeNull();
  });

  it("duplicate mid is ignored (idempotent)", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "OTHER", confidence: 0.9, lang: "roman" });
    const inbound = makeInbound("text", "mid_1", { text: "hello" });
    await handleMessage(payload("mid_1"), inbound, deps);
    await handleMessage(payload("mid_1"), inbound, deps);
    expect(deps.meta.sent).toHaveLength(1);
  });

  it("listing limit → polite limit reply, no listing", async () => {
    deps.maxListingsPerSellerPerDay = 1;
    deps.gemini.classifyIntentImpl = async () => ({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });
    const convo0 = await deps.db.getOrCreateConversation(IGSID);
    convo0.listings_today = 1;
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "bechni hai" }), deps);
    expect(deps.fdb.convos.get(IGSID)!.active_listing_id).toBeNull();
    expect(deps.meta.sent[0]!.opts.text).toMatch(/limit|kal/i);
  });

  it("daily limit resets on a new PKT day (yesterday's listings do not count)", async () => {
    deps.maxListingsPerSellerPerDay = 1;
    deps.gemini.classifyIntentImpl = async () => ({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });
    const convo0 = await deps.db.getOrCreateConversation(IGSID);
    convo0.listings_today = 1;
    convo0.listings_day = "2026-09-29"; // yesterday — now is 2026-09-30
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "bechni hai" }), deps);
    const convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.active_listing_id).not.toBeNull();
    expect(convo.listings_day).toBe("2026-09-30");
    expect(convo.listings_today).toBe(1); // reset to 0, then +1 for the new listing
  });
});

describe("handleMessage: guards", () => {
  it("human keyword → flag + holding reply + admin alert ONCE", async () => {
    const inbound = (mid: string) => makeInbound("text", mid, { text: "koi insan hai? baat karni hai" });
    await handleMessage(payload("mid_1"), inbound("mid_1"), deps);
    await handleMessage(payload("mid_2"), inbound("mid_2"), deps);

    const convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.human_needed).toBe(true);
    expect(deps.alerts).toHaveLength(1);
    expect(deps.alerts[0]!.text).toMatch(/Human requested/);
    expect(deps.meta.sent).toHaveLength(1); // holding reply only once
  });

  it("while human_needed, further messages are held (no bot chatter)", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    convo.human_needed = true;
    await handleMessage(payload("mid_9"), makeInbound("text", "mid_9", { text: "hello?" }), deps);
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("spam: 13th msg warns + alerts, 14th is silently ignored", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "OTHER", confidence: 0.9, lang: "roman" });
    for (let i = 1; i <= 14; i++) {
      await handleMessage(payload(`mid_${i}`), makeInbound("text", `mid_${i}`, { text: `msg ${i}` }), deps);
    }
    expect(deps.alerts.filter((a) => a.text.includes("Spam guard"))).toHaveLength(1);
    // 12 normal replies + 1 spam warning = 13 sends; the 14th sends nothing.
    expect(deps.meta.sent).toHaveLength(13);
  });

  it("blocked sender → ignored", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    convo.blocked = true;
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "hi" }), deps);
    expect(deps.meta.sent).toHaveLength(0);
  });

  it("unsupported kind (sticker/video) → polite 'send photos as images' reply", async () => {
    await handleMessage(
      payload("mid_1"),
      makeInbound("unsupported", "mid_1", { unsupported_hint: "sticker" }),
      deps,
    );
    expect(deps.meta.sent).toHaveLength(1);
    expect(deps.meta.sent[0]!.opts.text).toMatch(/photo|image|tasveer/i);
  });
});

describe("handleMessage: 24h window", () => {
  it("sendSafe pre-check: stale window → no send attempted, window_open=false", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    convo.last_user_msg_at = "2026-09-28T17:05:00.000Z"; // >24h before NOW
    const res = await sendSafe(deps, convo, { text: "hello" });
    expect(res.sent).toBe(false);
    expect(deps.meta.sent).toHaveLength(0);
    expect(deps.fdb.convos.get(IGSID)!.window_open).toBe(false);
  });

  it("Meta window error mid-send → window_open=false, send swallowed", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "OTHER", confidence: 0.9, lang: "roman" });
    // First message anchors the window; then we age it past 24h and send again.
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "hi" }), deps);
    expect(deps.meta.sent).toHaveLength(1);
    const convo = deps.fdb.convos.get(IGSID)!;
    convo.last_user_msg_at = "2026-09-28T17:05:00.000Z"; // >24h before NOW
    deps.meta.sendFailsWith = makeWindowError();
    await handleMessage(payload("mid_2"), makeInbound("text", "mid_2", { text: "hello again" }), deps);
    // handleMessage re-anchors last_user_msg_at on receipt, so the send IS attempted;
    // Meta's window error then flips window_open=false and the send is swallowed.
    expect(deps.fdb.convos.get(IGSID)!.window_open).toBe(false);
    expect(deps.meta.sent).toHaveLength(1); // no new successful send
  });
});

describe("handleMessage: NEEDS_INFO typed answers", () => {
  async function seedNeedsInfo() {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "NEEDS_INFO";
    listing.extracted = { ...blankTestExtracted(), category: "shirt", size: "M", condition: "good", city: "Karachi" };
    listing.photos = [
      makePhoto("sellers/x/0.jpg"),
      makePhoto("sellers/x/1.jpg"),
    ];
    listing.missing = ["price_pkr"];
    await deps.db.createListing(listing);
    convo.state = "NEEDS_INFO";
    convo.active_listing_id = "lst_1";
    return { convo, listing };
  }

  it("typed price answer → CONFIRM + preview + consent quick replies", async () => {
    await seedNeedsInfo();
    await handleMessage(payload("mid_5"), makeInbound("text", "mid_5", { text: "2500" }), deps);

    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.extracted!.price_pkr).toBe(2500);
    expect(listing.status).toBe("CONFIRM");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.text).toMatch(/public/i); // consent warning included
    expect(sent.opts.quickReplies!.map((q) => q.payload)).toEqual(
      expect.arrayContaining(["consent:post", "consent:cancel"]),
    );
  });

  it("unparseable answer → clarify retry, stays in NEEDS_INFO", async () => {
    await seedNeedsInfo();
    await handleMessage(payload("mid_5"), makeInbound("text", "mid_5", { text: "pata nahi" }), deps);
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("NEEDS_INFO");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("NEEDS_INFO");
    expect(deps.meta.sent[deps.meta.sent.length - 1]!.opts.text).toMatch(/2500|price|kimat/i);
  });

  it("quick_reply info tap → applies value", async () => {
    await seedNeedsInfo();
    await handleMessage(
      payload("mid_6"),
      makeInbound("quick_reply", "mid_6", { quick_reply_payload: "info:price_pkr:3000", text: "Rs 3000" }),
      deps,
    );
    expect(deps.fdb.listings.get("lst_1")!.extracted!.price_pkr).toBe(3000);
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
  });

  it("late unprocessed photo + answer → stays NEEDS_INFO, finalize re-armed, no confirm", async () => {
    await seedNeedsInfo();
    // A 3rd photo arrives after the first two were processed (ingest leaves
    // phash:"" — finalize fills it). The answer's activity bump invalidates
    // the photo's own armed finalize, so the answer must not confirm.
    const stored = deps.fdb.listings.get("lst_1")!;
    stored.photos.push({ storage_path: "sellers/x/2.jpg", w: 800, h: 1000, phash: "", received_at: NOW });
    stored.last_photo_at = NOW;
    stored.last_activity_at = NOW;
    await handleMessage(payload("mid_5"), makeInbound("text", "mid_5", { text: "2500" }), deps);

    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.extracted!.price_pkr).toBe(2500); // the answer WAS saved
    expect(updated.status).toBe("NEEDS_INFO");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("NEEDS_INFO");
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos").length).toBeGreaterThan(0);
    expect(deps.fdb.events.some((e) => e.event.type === "confirm")).toBe(false);
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.quickReplies).toBeUndefined(); // holding reply, no consent buttons
  });

  it("late unprocessed photo + details dump → stays NEEDS_INFO, finalize re-armed", async () => {
    await seedNeedsInfo();
    const stored = deps.fdb.listings.get("lst_1")!;
    stored.photos.push({ storage_path: "sellers/x/2.jpg", w: 800, h: 1000, phash: "", received_at: NOW });
    stored.last_photo_at = NOW;
    stored.last_activity_at = NOW;
    await handleMessage(payload("mid_5"), makeInbound("text", "mid_5", { text: "Price: 2500" }), deps);

    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.extracted!.price_pkr).toBe(2500);
    expect(updated.status).toBe("NEEDS_INFO");
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos").length).toBeGreaterThan(0);
    expect(deps.fdb.events.some((e) => e.event.type === "confirm")).toBe(false);
  });

  it("multi-line details dump applies every field → CONFIRM (Nina, 2026-11-23)", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "NEEDS_INFO";
    listing.extracted = { ...blankTestExtracted(), category: "jeans" };
    listing.photos = [makePhoto("sellers/x/0.jpg"), makePhoto("sellers/x/1.jpg")];
    listing.missing = ["size", "condition", "price_pkr", "city"];
    await deps.db.createListing(listing);
    convo.state = "NEEDS_INFO";
    convo.active_listing_id = "lst_1";

    const dump = [
      "Brand: Tinnie Tots",
      "Size: 5-6 years",
      "Condition: 10/10",
      "Original price: 3500",
      "Discounted price: 2k",
      "Dc: 250",
      "City: Lahore",
      "Measurements",
      'Length: 25.5"',
    ].join("\n");
    await handleMessage(payload("mid_7"), makeInbound("text", "mid_7", { text: dump }), deps);

    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.extracted!.brand).toBe("Tinnie Tots");
    expect(updated.extracted!.size).toBe("5-6 YEARS");
    expect(updated.extracted!.condition).toBe("like_new");
    expect(updated.extracted!.price_pkr).toBe(2000);
    expect(updated.extracted!.city).toBe("Lahore");
    expect(updated.extracted!.measurements).toBe('25.5"');
    expect(updated.status).toBe("CONFIRM");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
  });
});

describe("handleMessage: concurrent chat while COLLECTING", () => {
  it("two texts arriving together both land in chat_text (no lost update)", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "DRAFT";
    listing.photos = [makePhoto("sellers/x/0.jpg"), makePhoto("sellers/x/1.jpg")];
    await deps.db.createListing(listing);
    convo.state = "COLLECTING";
    convo.active_listing_id = "lst_1";
    convo.last_user_msg_at = NOW;

    await Promise.all([
      handleMessage(payload("mid_a"), makeInbound("text", "mid_a", { text: "pehli baat" }), deps),
      handleMessage(payload("mid_b"), makeInbound("text", "mid_b", { text: "dusri baat" }), deps),
    ]);
    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.chat_text).toMatch(/pehli baat/);
    expect(updated.chat_text).toMatch(/dusri baat/);
    expect(updated.photos).toHaveLength(2);
  });
});

describe("handleMessage: burst-combine — a details text re-arms finalize", () => {
  async function seedCollectingWithPhotos() {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "DRAFT";
    listing.photos = [makePhoto("sellers/x/0.jpg"), makePhoto("sellers/x/1.jpg")];
    listing.last_photo_at = NOW;
    listing.last_activity_at = NOW;
    await deps.db.createListing(listing);
    convo.state = "COLLECTING";
    convo.active_listing_id = "lst_1";
    convo.last_user_msg_at = NOW;
    return listing;
  }

  it("text on a listing with photos re-arms finalize with a fresh activity_at", async () => {
    await seedCollectingWithPhotos();
    await handleMessage(
      payload("mid_t"),
      makeInbound("text", "mid_t", { text: "Brand: Test Brand\nSize: M\nDiscounted price: 2k" }),
      deps,
    );
    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.chat_text).toMatch(/Test Brand/);
    expect(updated.last_activity_at).toBe(NOW);
    const finalize = deps.enqueued.filter((e) => e.route === "finalize-photos");
    expect(finalize).toHaveLength(1);
    expect(finalize[0]?.opts?.delaySec).toBe(25);
    expect(finalize[0]?.payload).toMatchObject({
      kind: "finalize-photos",
      listing_id: "lst_1",
      photo_at: NOW,
      activity_at: NOW,
    });
  });

  it("text on a listing with no photos does NOT arm finalize", async () => {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "DRAFT";
    listing.photos = [];
    await deps.db.createListing(listing);
    convo.state = "COLLECTING";
    convo.active_listing_id = "lst_1";
    convo.last_user_msg_at = NOW;
    await handleMessage(payload("mid_t"), makeInbound("text", "mid_t", { text: "hello, bechni hai" }), deps);
    const updated = deps.fdb.listings.get("lst_1")!;
    expect(updated.chat_text).toMatch(/hello, bechni hai/);
    expect(deps.enqueued.filter((e) => e.route === "finalize-photos")).toHaveLength(0);
  });
});

describe("handleMessage: consent", () => {
  async function seedConfirm() {
    const convo = await deps.db.getOrCreateConversation(IGSID);
    const listing = deps.db.blankListingDoc("lst_1", IGSID, NOW);
    listing.status = "CONFIRM";
    listing.extracted = fullTestExtracted();
    listing.photos = [
      makePhoto("sellers/x/0.jpg"),
      makePhoto("sellers/x/1.jpg"),
    ];
    await deps.db.createListing(listing);
    convo.state = "CONFIRM";
    convo.active_listing_id = "lst_1";
  }

  it("consent:post → SUBMITTED + publish enqueued + thanks", async () => {
    await seedConfirm();
    await handleMessage(
      payload("mid_9"),
      makeInbound("quick_reply", "mid_9", { quick_reply_payload: "consent:post", text: "Post it" }),
      deps,
    );
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("SUBMITTED");
    expect(listing.consent).toBeTruthy();
    const convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.state).toBe("IDLE");
    expect(convo.active_listing_id).toBeNull();
    expect(deps.enqueued).toHaveLength(1);
    expect(deps.enqueued[0]).toMatchObject({ route: "publish", payload: { kind: "publish", listing_id: "lst_1" } });
    expect(deps.fdb.events.some((e) => e.event.type === "consent")).toBe(true);
  });

  it("consent:cancel → REJECTED + IDLE", async () => {
    await seedConfirm();
    await handleMessage(
      payload("mid_9"),
      makeInbound("quick_reply", "mid_9", { quick_reply_payload: "consent:cancel", text: "Cancel" }),
      deps,
    );
    expect(deps.fdb.listings.get("lst_1")!.status).toBe("REJECTED");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("IDLE");
  });

  it("consent:edit → NEEDS_INFO asking for a new caption", async () => {
    await seedConfirm();
    await handleMessage(
      payload("mid_9"),
      makeInbound("quick_reply", "mid_9", { quick_reply_payload: "consent:edit", text: "Edit" }),
      deps,
    );
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.status).toBe("NEEDS_INFO");
    expect(listing.missing).toEqual(["caption"]);
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("NEEDS_INFO");
  });

  it("consent:edit → typed caption is kept (not regenerated) + preview shows it", async () => {
    await seedConfirm();
    await handleMessage(
      payload("mid_9"),
      makeInbound("quick_reply", "mid_9", { quick_reply_payload: "consent:edit", text: "Edit" }),
      deps,
    );
    await handleMessage(
      payload("mid_10"),
      makeInbound("text", "mid_10", { text: "My preloved Zara dress, barely worn!" }),
      deps,
    );
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.caption).toBe("My preloved Zara dress, barely worn!");
    expect(listing.status).toBe("CONFIRM");
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.text).toContain("My preloved Zara dress, barely worn!");
    expect(sent.opts.quickReplies!.map((q) => q.payload)).toEqual(
      expect.arrayContaining(["consent:post", "consent:cancel"]),
    );
  });

  it("caption containing a 'Key: value' line is kept verbatim (not parsed as a field dump)", async () => {
    await seedConfirm();
    await handleMessage(
      payload("mid_9"),
      makeInbound("quick_reply", "mid_9", { quick_reply_payload: "consent:edit", text: "Edit" }),
      deps,
    );
    await handleMessage(
      payload("mid_10"),
      makeInbound("text", "mid_10", { text: "My Zara dress, barely worn!\nPrice: 1500 is a steal" }),
      deps,
    );
    const listing = deps.fdb.listings.get("lst_1")!;
    expect(listing.caption).toBe("My Zara dress, barely worn!\nPrice: 1500 is a steal");
    expect(listing.extracted!.price_pkr).toBe(2500); // not overwritten by the "Price:" line
    expect(listing.status).toBe("CONFIRM");
  });

  it("CONFIRM + stray text → nudge with consent buttons (no state change)", async () => {
    await seedConfirm();
    await handleMessage(payload("mid_9"), makeInbound("text", "mid_9", { text: "hmm" }), deps);
    expect(deps.fdb.convos.get(IGSID)!.state).toBe("CONFIRM");
    const sent = deps.meta.sent[deps.meta.sent.length - 1]!;
    expect(sent.opts.quickReplies!.map((q) => q.payload)).toContain("consent:post");
  });
});

describe("scripted multi-turn flow", () => {
  it("IDLE→COLLECTING→NEEDS_INFO→CONFIRM→SUBMITTED", async () => {
    deps.gemini.classifyIntentImpl = async () => ({ intent: "SELLER_SUBMIT", confidence: 0.9, lang: "roman" });

    // 1. Seller opens with text.
    await handleMessage(payload("mid_1"), makeInbound("text", "mid_1", { text: "shirt bechni hai" }), deps);
    let convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.state).toBe("COLLECTING");
    const listingId = convo.active_listing_id!;

    // 2. More chat while collecting.
    await handleMessage(payload("mid_2"), makeInbound("text", "mid_2", { text: "zara ki hai" }), deps);
    expect(deps.fdb.listings.get(listingId)!.chat_text).toMatch(/zara/);

    // 3. Photos finalized elsewhere → NEEDS_INFO with one missing field.
    const listing = deps.fdb.listings.get(listingId)!;
    listing.status = "NEEDS_INFO";
    listing.extracted = { ...fullTestExtracted(), price_pkr: null };
    listing.photos = [
      makePhoto("sellers/x/0.jpg"),
      makePhoto("sellers/x/1.jpg"),
    ];
    listing.missing = ["price_pkr"];
    convo.state = "NEEDS_INFO";

    // 4. Seller answers the price question.
    await handleMessage(payload("mid_3"), makeInbound("text", "mid_3", { text: "Rs 2,500" }), deps);
    convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.state).toBe("CONFIRM");

    // 5. Seller taps Post it.
    await handleMessage(
      payload("mid_4"),
      makeInbound("quick_reply", "mid_4", { quick_reply_payload: "consent:post", text: "Post it" }),
      deps,
    );
    convo = deps.fdb.convos.get(IGSID)!;
    expect(convo.state).toBe("IDLE");
    expect(deps.fdb.listings.get(listingId)!.status).toBe("SUBMITTED");
    expect(deps.enqueued[0]).toMatchObject({ route: "publish", payload: { kind: "publish", listing_id: listingId } });

    // 6. Vision sanity: the fake extraction path feeds the same shape.
    expect(makeVisionResult().extracted.price_pkr).toBe(2500);
  });
});
