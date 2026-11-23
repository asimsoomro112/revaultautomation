/**
 * Publish-slot math — PURE functions (no I/O), Asia/Karachi by default.
 *
 * Plan §10 slot rule:
 *   slot = now
 *   if postsToday >= maxPostsPerDay → slot = tomorrow windowStart
 *   slot = max(slot, lastPublishAt + minGapMinutes)
 *   if slot > windowEnd → slot = next day windowStart
 *   if slot < windowStart → slot = today windowStart
 *
 * All wall-clock arithmetic is done via Intl.DateTimeFormat with the supplied
 * tz (PKT has no DST — asserted in tests), so the math stays correct across
 * day/month/year rollovers.
 */

export interface SlotInput {
  now: Date;
  postsToday: number;
  lastPublishAt: Date | null;
  maxPostsPerDay: number;
  minGapMinutes: number;
  /** "HH:MM" 24h wall time, e.g. "12:00". */
  windowStart: string;
  /** "HH:MM" 24h wall time, e.g. "23:00". */
  windowEnd: string;
  /** IANA zone, e.g. "Asia/Karachi". */
  tz: string;
}

interface WallParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  min: number;
}

function parseHM(s: string): { h: number; min: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid HH:MM window value: ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid HH:MM window value: ${s}`);
  return { h, min };
}

/** Wall-clock parts of an instant in the given tz. */
export function tzParts(date: Date, tz: string): WallParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    if (!p) throw new Error(`Intl did not return ${t} for ${tz}`);
    return Number(p.value);
  };
  let h = get("hour");
  // en-US hour12:false can emit "24" for midnight in some ICU builds.
  if (h === 24) h = 0;
  return { y: get("year"), mo: get("month"), d: get("day"), h, min: get("minute") };
}

/** Offset of `tz` at `date`, in ms (local = utc + offset). */
function tzOffsetMs(tz: string, date: Date): number {
  const p = tzParts(date, tz);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.min);
  // Truncate the instant to the minute so seconds don't leak into the offset.
  const truncated = Math.floor(date.getTime() / 60000) * 60000;
  return asUTC - truncated;
}

/**
 * Convert a wall time in `tz` to the corresponding UTC instant.
 * Iterates to converge for zones with DST; converges immediately for fixed
 * offsets like Asia/Karachi.
 */
export function wallToUtc(tz: string, y: number, mo: number, d: number, h: number, min: number): Date {
  const wallAsUTC = Date.UTC(y, mo - 1, d, h, min, 0, 0);
  let guess = wallAsUTC;
  for (let i = 0; i < 4; i++) {
    guess = wallAsUTC - tzOffsetMs(tz, new Date(guess));
  }
  return new Date(guess);
}

/** "yyyy-MM-dd" of an instant in the given tz (PKT day for counters). */
export function tzDay(date: Date, tz: string): string {
  const p = tzParts(date, tz);
  const mm = String(p.mo).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${p.y}-${mm}-${dd}`;
}

/** Tomorrow at windowStart in `tz` — used when the quota/day is exhausted. */
export function tomorrowWindowStart(now: Date, windowStart: string, tz: string): Date {
  const p = tzParts(now, tz);
  const { h, min } = parseHM(windowStart);
  return wallToUtc(tz, p.y, p.mo, p.d + 1, h, min);
}

export function computeNextSlot(i: SlotInput): Date {
  const p = tzParts(i.now, i.tz);
  const ws = parseHM(i.windowStart);
  const we = parseHM(i.windowEnd);

  // Daily cap hit → first slot tomorrow.
  if (i.postsToday >= i.maxPostsPerDay) {
    return wallToUtc(i.tz, p.y, p.mo, p.d + 1, ws.h, ws.min);
  }

  let slot = i.now;
  if (i.lastPublishAt) {
    const gapAt = new Date(i.lastPublishAt.getTime() + i.minGapMinutes * 60_000);
    if (gapAt.getTime() > slot.getTime()) slot = gapAt;
  }

  const todayStart = wallToUtc(i.tz, p.y, p.mo, p.d, ws.h, ws.min);
  const todayEnd = wallToUtc(i.tz, p.y, p.mo, p.d, we.h, we.min);

  if (slot.getTime() < todayStart.getTime()) return todayStart;
  if (slot.getTime() > todayEnd.getTime()) {
    return wallToUtc(i.tz, p.y, p.mo, p.d + 1, ws.h, ws.min);
  }
  return slot;
}
