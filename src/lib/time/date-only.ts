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
 * full instant.
 *
 * FORMATTING LIVES ELSEWHERE — deliberately. `formatDateOnly` used to sit here:
 * it rebuilt a LOCAL date from the calendar parts and formatted in the viewer's
 * locale. That closed the day-shift but left a second hole. A locale-dependent
 * string rendered during SSR differs between the container and the browser, and
 * React raises hydration error #418 — which this app surfaces as a "Something
 * went wrong" toast.
 *
 * `formatDateStable` in `@/lib/format/stable-date` closes both at once. Pinning
 * the formatter to UTC returns the SAME calendar day for a UTC-midnight `DATE`
 * value (`"2026-07-20T00:00:00.000Z"` → `7/20/2026`, never 7/19) and produces
 * byte-identical text on server and client.
 *
 * So: `dateOnlyKey` to group and sort, `formatDateStable` to display. Both read
 * the value in UTC, so they cannot disagree about which day it is — the same
 * property that stopped the list view and the week grid drifting apart, now
 * holding across the server/client boundary too.
 */

/** The calendar day, as `YYYY-MM-DD`. Accepts a bare date or a full instant. */
export function dateOnlyKey(value: string): string {
  return value.slice(0, 10);
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
