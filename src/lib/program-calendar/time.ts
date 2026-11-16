/**
 * Dates on the program calendar.
 *
 * Two kinds of event live in one pair of columns, and the whole file exists to
 * keep them apart:
 *
 * - A TIMED event is an instant. `startsAt`/`endsAt` are real UTC instants and
 *   `timeZone` records the zone it was entered in, so it can be shown back in
 *   the program's zone rather than the reader's laptop's.
 * - An ALL-DAY event is a DATE. It is stored as UTC midnight on its first day
 *   to UTC midnight after its last, and must be read as a plain date in every
 *   zone — "an all-day event is on its dates in every time zone".
 *
 * The classic bug is running an all-day event through a zone conversion: UTC
 * midnight rendered in any zone west of UTC is the PREVIOUS day, so a
 * three-day event silently starts a day early for everyone west of UTC. Every
 * all-day read goes through `allDayParts` here, which reads the UTC fields and
 * never the local ones.
 */

/** `endsAt` is EXCLUSIVE for all-day events: a one-day event ends at the next
 *  UTC midnight. Half-open ranges are what make "does this day contain it"
 *  a single comparison with no off-by-one at the boundary. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Today on the READER's calendar, as that date's UTC midnight: the grid's clock
 * of UTC dates, read off the reader's own wall clock. At 20:00 in Los Angeles
 * the UTC date is already tomorrow, and an event is drawn on the date it is
 * held (`drawnRange`), so "today" is the reader's date too.
 */
export function localToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** UTC midnight of the day `d` falls on, read in UTC. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Normalize a submitted range into what gets stored.
 *
 * All-day: snap to UTC midnight and make the end exclusive, so a single-day
 * event spans exactly one day rather than collapsing to a zero-length instant
 * (which would make it belong to no day at all in a half-open comparison).
 */
export function normalizeRange(input: {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
}): { startsAt: Date; endsAt: Date } {
  if (!input.allDay) {
    // A timed event that ends before it starts is a typo, not a range. Keep it
    // non-negative rather than rejecting: the form already validates, and a
    // stored inverted range would break every overlap query silently.
    const endsAt = input.endsAt < input.startsAt ? input.startsAt : input.endsAt;
    return { startsAt: input.startsAt, endsAt };
  }
  const start = utcMidnight(input.startsAt);
  let end = utcMidnight(input.endsAt);
  if (end <= start) end = new Date(start.getTime() + DAY_MS);
  else end = new Date(end.getTime() + DAY_MS); // the end date is inclusive to the user
  return { startsAt: start, endsAt: end };
}

// ── A timed event's own clock ────────────────────────────────────────────────

/** One formatter per zone: building an `Intl.DateTimeFormat` is the slow part,
 *  and the grid reads every event once per week it might fall in. `null` marks
 *  a zone `Intl` does not know. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = zoneFormatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      f = null;
    }
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

/** Is this a zone `Intl` will actually accept? */
export function isIanaZone(value: string): boolean {
  return value !== "" && zoneFormatter(value) !== null;
}

/**
 * Milliseconds `timeZone` is ahead of UTC at `at` (DST included).
 *
 * A zone `Intl` does not know reads as UTC, which is what the chips already
 * fall back to: one stored typo must not take down every calendar it is on.
 */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const f = timeZone ? zoneFormatter(timeZone) : null;
  if (!f) return 0;
  const parts = f.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    part("year"), part("month") - 1, part("day"),
    // Some environments render midnight as hour 24 even under h23.
    part("hour") % 24, part("minute"), part("second"),
  );
  // The parts carry whole seconds, so compare against whole seconds too.
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which it is `y-m-d hh:mm` in `timeZone`.
 *
 * Offset-then-correct: the zone's offset is itself a function of the instant,
 * so the first guess is measured at the wrong moment near a DST boundary. The
 * second measurement settles it (and for a wall clock inside a spring-forward
 * gap, which does not exist, it lands on the instant just after the jump).
 */
export function zonedInstant(
  y: number, m: number, d: number, hh: number, mm: number, timeZone: string,
): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = zoneOffsetMs(new Date(wall), timeZone);
  let t = wall - first;
  const second = zoneOffsetMs(new Date(t), timeZone);
  if (second !== first) t = wall - second;
  return new Date(t);
}

/**
 * An instant as its wall-clock reading in `timeZone`, expressed as that same
 * reading in UTC.
 *
 * The grid lays days out as UTC dates. A meeting at 17:00 in Los Angeles is
 * 01:00 UTC the NEXT day, so drawn as an instant it lands in the wrong column.
 * Moving the instant onto the clock it belongs to, once, and then reading it as
 * UTC puts the day and the hour on the same clock.
 */
export function wallClock(instant: Date, timeZone: string): Date {
  return new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
}

/**
 * Where the grid draws an event, on its clock of UTC dates.
 *
 * An all-day event is stored as UTC-midnight dates and is drawn as stored. A
 * timed event is drawn on the clock of the zone it was entered in, the zone its
 * chip shows its time in, so a 19:00 review in Los Angeles is on the evening it
 * is held and not on the next UTC day. The month grid's column, the week grid's
 * column AND hour offset, and the server's window all read this one
 * conversion, so they cannot disagree about the day.
 *
 * Overlay items are already on the grid's clock and say `timeZone: "UTC"`.
 */
export function drawnRange(e: {
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  timeZone?: string;
}): { startsAt: Date; endsAt: Date } {
  if (e.allDay || !e.timeZone || e.timeZone === "UTC") return { startsAt: e.startsAt, endsAt: e.endsAt };
  return { startsAt: wallClock(e.startsAt, e.timeZone), endsAt: wallClock(e.endsAt, e.timeZone) };
}

/**
 * How far an event's instants can sit outside the dates it is drawn on. No
 * zone is more than 14 hours from UTC, so a day either side holds every event
 * drawn in a window: read the padded window, then cut back with `drawnRange`.
 */
export const DRAWN_PAD_MS = DAY_MS;

/** The calendar dates an all-day event covers, as UTC y/m/d parts. */
export function allDayParts(startsAt: Date, endsAt: Date): { y: number; m: number; d: number }[] {
  const out: { y: number; m: number; d: number }[] = [];
  for (let t = utcMidnight(startsAt).getTime(); t < endsAt.getTime(); t += DAY_MS) {
    const d = new Date(t);
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() });
  }
  return out;
}

/**
 * Does the event touch the half-open window [from, to)?
 *
 * Half-open on BOTH sides. An event that ends exactly when the window opens
 * does not touch it, and one that starts exactly as the window closes belongs
 * to the next window — otherwise an event lands in two months at once and the
 * month grid draws it twice.
 */
export function overlaps(
  ev: { startsAt: Date; endsAt: Date },
  from: Date,
  to: Date,
): boolean {
  return ev.startsAt < to && ev.endsAt > from;
}

/** The half-open window covering the month grid that contains `anchor`,
 *  padded out to whole weeks (Sunday-first) so leading and trailing days of
 *  the adjacent months are populated too. */
export function monthGridWindow(anchor: Date): { from: Date; to: Date } {
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const from = new Date(first.getTime() - first.getUTCDay() * DAY_MS);
  const nextMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  // Pad to the end of the week the last day falls in.
  const trailing = (7 - nextMonth.getUTCDay()) % 7;
  const to = new Date(nextMonth.getTime() + trailing * DAY_MS);
  return { from, to };
}

/** The half-open window for the week containing `anchor` (Sunday-first). */
export function weekWindow(anchor: Date): { from: Date; to: Date } {
  const start = utcMidnight(anchor);
  const from = new Date(start.getTime() - start.getUTCDay() * DAY_MS);
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** The half-open window for the single day containing `anchor`. */
export function dayWindow(anchor: Date): { from: Date; to: Date } {
  const from = utcMidnight(anchor);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/** The half-open window for `days` days starting at `anchor`'s day. */
export function rollingWindow(anchor: Date, days: number): { from: Date; to: Date } {
  const from = utcMidnight(anchor);
  return { from, to: new Date(from.getTime() + days * DAY_MS) };
}
