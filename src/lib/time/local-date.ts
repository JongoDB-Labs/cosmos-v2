/**
 * The viewer's calendar day, as `YYYY-MM-DD`.
 *
 * Cosmos has THREE kinds of date value, and the failures come from using one's
 * tooling on another:
 *
 *  1. **Instant** — a moment (`createdAt`, a timer's start). Stored UTC,
 *     rendered in the viewer's zone. `toLocaleString()` is correct here.
 *  2. **Calendar date** — a day with no time (a due date, a timesheet day, a
 *     sprint's end). Stored as a Postgres `DATE`, which serialises at UTC
 *     midnight. Read it back **in UTC** — `formatDateStable` exists for this.
 *     Converting it to a local zone shows the PREVIOUS day west of UTC, which
 *     is the 7/19-vs-7/20 bug already scarred into time-tracker.
 *  3. **"Today"** — deriving a calendar date from *now*, for a viewer. That is
 *     what this function is for, and the only one of the three that must read
 *     the LOCAL clock.
 *
 * `toISOString().slice(0, 10)` answers (3) in UTC, so from 20:00 Eastern onward
 * it returns tomorrow: the timesheet defaulted to the wrong day, and a journal
 * entry would post into it.
 *
 * Built from local getters rather than `toISOString`, so no zone conversion
 * happens at all.
 */
export function localDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
