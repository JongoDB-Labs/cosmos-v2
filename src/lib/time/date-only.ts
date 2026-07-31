/**
 * Date-ONLY values, formatted without a timezone anywhere near them.
 *
 * `TimeEntry.date` is a Postgres `DATE` (`@db.Date`). Prisma serialises it as
 * an ISO instant at UTC midnight — `"2026-07-20T00:00:00.000Z"` — but the value
 * means a CALENDAR DAY, not a moment. Handing that to a timestamp-aware
 * formatter converts it into the viewer's zone and, anywhere west of UTC, lands
 * on the previous day:
 *
 *     new Date("2026-07-20T00:00:00.000Z").toLocaleDateString()  // "7/19/2026" at UTC-4
 *
 * Observed on production: the list view showed 7/19 while the week grid — which
 * buckets on the raw `startsWith("2026-07-20")` prefix — drew the same entry on
 * Jul 20. Two views of one entry, one day apart, and the list was wrong.
 *
 * On a timesheet that is not cosmetic. The day an entry falls on decides which
 * week it belongs to, which pay period bills it, and whether Friday's hours
 * land on Saturday.
 *
 * The rule: take the `YYYY-MM-DD` prefix and never construct a `Date` from the
 * full instant. Both helpers here derive from `dateOnlyKey`, so the display
 * string and the grouping key cannot drift apart again — which is exactly how
 * the two views came to disagree.
 */

/** The calendar day, as `YYYY-MM-DD`. Accepts a bare date or a full instant. */
export function dateOnlyKey(value: string): string {
  return value.slice(0, 10);
}

/**
 * Format a date-only value for display in the viewer's locale.
 *
 * Builds a LOCAL date from the calendar parts, so no zone conversion can occur
 * — `new Date(2026, 6, 20)` is local midnight on the 20th everywhere.
 */
export function formatDateOnly(value: string, locale?: string): string {
  const [y, m, d] = dateOnlyKey(value).split("-").map(Number);
  // Anything we can't parse is passed through rather than rendered as
  // "Invalid Date" — a wrong-looking date is still more useful than a crash.
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString(locale);
}

/**
 * Sort comparator for date-only values, most recent first.
 *
 * Compares the `YYYY-MM-DD` strings directly: ISO dates sort correctly
 * lexicographically, and it keeps sorting on the same value the display and
 * grouping use.
 */
export function byDateOnlyDesc(a: { date: string }, b: { date: string }): number {
  return dateOnlyKey(b.date).localeCompare(dateOnlyKey(a.date));
}
