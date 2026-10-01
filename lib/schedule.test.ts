/**
 * Schedule-math tests — Asia/Karachi slot computation (plan §10).
 * PKT = UTC+5, no DST (asserted). All expectations are absolute UTC instants.
 */
import { describe, expect, it } from "vitest";
import {
  computeNextSlot,
  tomorrowWindowStart,
  tzDay,
  tzParts,
  wallToUtc,
  type SlotInput,
} from "./schedule";

const TZ = "Asia/Karachi";

function base(over: Partial<SlotInput>): SlotInput {
  return {
    now: new Date("2026-09-30T10:00:00Z"), // 15:00 PKT — inside window
    postsToday: 0,
    lastPublishAt: null,
    maxPostsPerDay: 6,
    minGapMinutes: 90,
    windowStart: "12:00",
    windowEnd: "23:00",
    tz: TZ,
    ...over,
  };
}

const iso = (s: string) => new Date(s).getTime();

describe("computeNextSlot", () => {
  it("inside window, no constraints → now", () => {
    expect(computeNextSlot(base({})).getTime()).toBe(iso("2026-09-30T10:00:00Z"));
  });

  it("before window → today 12:00 PKT", () => {
    // 10:30 PKT
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T05:30:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-09-30T07:00:00Z")); // 12:00 PKT
  });

  it("exactly at window start → now (boundary inclusive)", () => {
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T07:00:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-09-30T07:00:00Z"));
  });

  it("exactly at window end → now (boundary inclusive, not pushed out)", () => {
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T18:00:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-09-30T18:00:00Z")); // 23:00 PKT
  });

  it("after window → next day 12:00 PKT (PKT day rollover)", () => {
    // 23:30 PKT on Sep 30
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T18:30:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z")); // Oct 1, 12:00 PKT
  });

  it("just after midnight PKT → today 12:00", () => {
    // 00:30 PKT on Oct 1
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T19:30:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("gap overlap inside window → lastPublishAt + gap", () => {
    const slot = computeNextSlot(
      base({
        now: new Date("2026-09-30T17:00:00Z"), // 22:00 PKT
        lastPublishAt: new Date("2026-09-30T16:30:00Z"), // 21:30 PKT
      }),
    );
    expect(slot.getTime()).toBe(iso("2026-09-30T18:00:00Z")); // 23:00 PKT
  });

  it("gap pushes past window end → next day 12:00", () => {
    const slot = computeNextSlot(
      base({
        now: new Date("2026-09-30T17:30:00Z"), // 22:30 PKT
        lastPublishAt: new Date("2026-09-30T17:00:00Z"), // 22:00 PKT +90m = 23:30 > 23:00
      }),
    );
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("gap already satisfied → now", () => {
    const slot = computeNextSlot(
      base({
        now: new Date("2026-09-30T12:00:00Z"), // 17:00 PKT
        lastPublishAt: new Date("2026-09-30T08:00:00Z"), // 13:00 PKT +90m = 14:30 < 17:00
      }),
    );
    expect(slot.getTime()).toBe(iso("2026-09-30T12:00:00Z"));
  });

  it("max posts reached → tomorrow 12:00 even mid-window", () => {
    const slot = computeNextSlot(base({ postsToday: 6 }));
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("posts over max (defensive) → tomorrow 12:00", () => {
    const slot = computeNextSlot(base({ postsToday: 9 }));
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("one slot left → now", () => {
    const slot = computeNextSlot(base({ postsToday: 5 }));
    expect(slot.getTime()).toBe(iso("2026-09-30T10:00:00Z"));
  });

  it("month rollover: Sep 30 night → Oct 1 12:00", () => {
    const slot = computeNextSlot(base({ now: new Date("2026-09-30T18:01:00Z") }));
    expect(slot.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("year rollover: Dec 31 night PKT → Jan 1 12:00", () => {
    // 2027-01-01 00:30 PKT
    const slot = computeNextSlot(base({ now: new Date("2026-12-31T19:30:00Z") }));
    expect(slot.getTime()).toBe(iso("2027-01-01T07:00:00Z"));
  });

  it("lastPublishAt in the future (clock skew) still respected", () => {
    const slot = computeNextSlot(
      base({
        now: new Date("2026-09-30T10:00:00Z"),
        lastPublishAt: new Date("2026-09-30T10:30:00Z"),
      }),
    );
    expect(slot.getTime()).toBe(iso("2026-09-30T12:00:00Z")); // 10:30Z + 90m
  });
});

describe("PKT has no DST", () => {
  it("offset is +5h in January and July", () => {
    expect(wallToUtc(TZ, 2026, 1, 15, 12, 0).getTime()).toBe(iso("2026-01-15T07:00:00Z"));
    expect(wallToUtc(TZ, 2026, 7, 15, 12, 0).getTime()).toBe(iso("2026-07-15T07:00:00Z"));
  });

  it("tzParts agrees with the +5h offset across the year", () => {
    for (const m of [1, 4, 7, 10]) {
      const p = tzParts(new Date(Date.UTC(2026, m - 1, 15, 7, 0, 0)), TZ);
      expect([p.y, p.mo, p.d, p.h, p.min]).toEqual([2026, m, 15, 12, 0]);
    }
  });
});

describe("helpers", () => {
  it("tzDay returns the PKT calendar day", () => {
    expect(tzDay(new Date("2026-09-30T19:00:00Z"), TZ)).toBe("2026-10-01");
    expect(tzDay(new Date("2026-09-30T18:59:59Z"), TZ)).toBe("2026-09-30");
  });

  it("tomorrowWindowStart", () => {
    const t = tomorrowWindowStart(new Date("2026-09-30T10:00:00Z"), "12:00", TZ);
    expect(t.getTime()).toBe(iso("2026-10-01T07:00:00Z"));
  });

  it("rejects malformed window values", () => {
    expect(() => computeNextSlot(base({ windowStart: "nope" }))).toThrow();
    expect(() => computeNextSlot(base({ windowEnd: "25:00" }))).toThrow();
  });
});
