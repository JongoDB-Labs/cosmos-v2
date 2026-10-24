/**
 * Date arithmetic for CQL, in the REQUEST time zone.
 *
 * `startOfWeek()` for someone in Honolulu is not UTC's Monday, so every calendar
 * computation takes an IANA zone (the client sends its own; subscriptions store
 * one). Weeks start on Monday (ISO). Pure: `now` is always passed in, so one
 * query sees one instant (the board filters learned that the hard way).
 *
 * Offsets follow JQL: `-7d` is seven 24-hour days before now, `-1M` a calendar
 * month, `-30m` thirty minutes. `-3wd` is different on purpose: three WORKING
 * days back (weekends skipped), snapped to the start of that day, because "since
 * the previous working day" is what a standup means by it.
 */

export type Period = "day" | "week" | "month" | "year";

interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  ms: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** True for a zone Intl understands. Unknown zones fall back to UTC upstream. */
export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function partsIn(date: Date, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(date)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, ss: p.second, ms: date.getUTCMilliseconds() };
}

/** The UTC instant at which the wall clock in `tz` reads the given parts. */
function fromParts(p: Parts, tz: string): Date {
  const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss, p.ms);
  // Two passes settle DST transitions: the offset at the guess, then at the result.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(new Date(t), tz);
    const seenUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm, seen.ss, p.ms);
    t += guess - seenUtc;
  }
  return new Date(t);
}

/** Day of week in `tz`: 1 = Monday … 7 = Sunday. */
function isoWeekday(p: Parts): number {
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function addDays(p: Parts, n: number): Parts {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { ...p, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function addMonths(p: Parts, n: number): Parts {
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  // Clamp: one month after 31 January is 28/29 February, not 3 March.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { ...p, y, m, d: Math.min(p.d, last) };
}

const midnight = (p: Parts): Parts => ({ ...p, hh: 0, mm: 0, ss: 0, ms: 0 });

export function startOf(period: Period, now: Date, tz: string, offset = 0): Date {
  let p = midnight(partsIn(now, tz));
  switch (period) {
    case "day":
      p = addDays(p, offset);
      break;
    case "week":
      p = addDays(p, -(isoWeekday(p) - 1) + 7 * offset);
      break;
    case "month":
      p = addMonths({ ...p, d: 1 }, offset);
      break;
    case "year":
      p = { ...p, y: p.y + offset, m: 1, d: 1 };
      break;
  }
  return fromParts(p, tz);
}

/** The last millisecond of the period. */
export function endOf(period: Period, now: Date, tz: string, offset = 0): Date {
  return new Date(startOf(period, now, tz, offset + 1).getTime() - 1);
}

/** Start of the day `n` working days from today (negative = back). Weekends skipped. */
export function workingDaysFrom(now: Date, tz: string, n: number): Date {
  let p = midnight(partsIn(now, tz));
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    p = addDays(p, step);
    if (isoWeekday(p) <= 5) left--;
  }
  return fromParts(p, tz);
}

const REL = /^([+-]?)(\d{1,5})(wd|y|M|w|d|h|m)$/;

export function parseRel(v: string): { sign: number; n: number; unit: string } | null {
  const m = REL.exec(v);
  if (!m) return null;
  return { sign: m[1] === "-" ? -1 : 1, n: Number(m[2]), unit: m[3] };
}

/** Apply a JQL-style offset to `now`. */
export function applyRel(v: string, now: Date, tz: string): Date {
  const r = parseRel(v);
  if (!r) throw new Error(`Invalid relative date ${v}`);
  const k = r.sign * r.n;
  switch (r.unit) {
    case "wd":
      return workingDaysFrom(now, tz, k);
    case "m":
      return new Date(now.getTime() + k * 60_000);
    case "h":
      return new Date(now.getTime() + k * 3_600_000);
    case "d":
      return new Date(now.getTime() + k * 86_400_000);
    case "w":
      return new Date(now.getTime() + k * 7 * 86_400_000);
    case "M":
      return fromParts(addMonths(partsIn(now, tz), k), tz);
    case "y":
      return fromParts(addMonths(partsIn(now, tz), 12 * k), tz);
  }
  throw new Error(`Invalid relative date ${v}`);
}

/**
 * The offset argument of startOfWeek(-1w) etc. A bare number counts the
 * function's own period (WIQL's rule); a unit converts where it can.
 */
export function periodOffset(period: Period, arg: { t: "rel"; v: string } | { t: "num"; v: number } | undefined): number {
  if (!arg) return 0;
  if (arg.t === "num") return Math.trunc(arg.v);
  const r = parseRel(arg.v);
  if (!r) return 0;
  const k = r.sign * r.n;
  const perUnit: Record<Period, Record<string, number>> = {
    day: { d: 1, w: 7, wd: 1 },
    week: { w: 1, d: 1 / 7 },
    month: { M: 1, y: 12 },
    year: { y: 1 },
  };
  const f = perUnit[period][r.unit];
  return f ? Math.trunc(k * f) : k;
}

/** A date literal's day as [start, nextStart) in `tz`; a datetime literal is an instant. */
export function literalRange(v: string, tz: string): { from: Date; to: Date } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    const from = fromParts({ y, m, d, hh: 0, mm: 0, ss: 0, ms: 0 }, tz);
    const to = fromParts(addDays({ y, m, d, hh: 0, mm: 0, ss: 0, ms: 0 }, 1), tz);
    return { from, to };
  }
  const t = new Date(v);
  return { from: t, to: new Date(t.getTime() + 1) };
}

/** The day containing an instant, in `tz`, as [start, nextStart). */
export function dayOf(instant: Date, tz: string): { from: Date; to: Date } {
  return { from: startOf("day", instant, tz), to: startOf("day", instant, tz, 1) };
}

/** Seconds for a duration literal on an estimate field: 1d = 8h, 1w = 5d. */
export function durationSeconds(v: string): number | null {
  const r = parseRel(v);
  if (!r || r.sign < 0) return null;
  const per: Record<string, number> = { m: 60, h: 3600, d: 8 * 3600, w: 5 * 8 * 3600 };
  return per[r.unit] ? r.n * per[r.unit] : null;
}
