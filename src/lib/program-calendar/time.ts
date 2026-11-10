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
