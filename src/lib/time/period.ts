import { dateOnlyKey } from "./date-only";

/**
 * Which pay period a given day belongs to.
 *
 * All arithmetic is on `YYYY-MM-DD` strings and UTC-constructed dates, never on
 * local time. A period boundary computed in the viewer's zone would put an
 * entry in the wrong pay period — the same class of bug as 2.250.1, but with
 * money attached instead of a label.
 *
 * A period is resolved PER ENTRY, from that entry's own date. That is what
 * makes semi-monthly work: a week spanning the 15th genuinely belongs to two
 * periods, and each day lands in the right one rather than the whole week
 * being dragged into whichever period its Monday falls in. Payroll computes it
 * this way, so anything else disagrees with the cheque.
 */
export type PeriodLength = "WEEKLY" | "BIWEEKLY" | "SEMIMONTHLY";

export type Period = {
  /** Inclusive first day, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  end: string;
};

/** A Monday, used as the fixed origin for biweekly blocks. Arbitrary but
 *  STABLE — changing it would silently re-slice every existing period. */
const BIWEEKLY_ANCHOR = Date.UTC(1970, 0, 5);
const DAY_MS = 86_400_000;

function toUtc(dateOnly: string): number {
  const [y, m, d] = dateOnlyKey(dateOnly).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days since Monday (0 = Monday … 6 = Sunday). JS getUTCDay is Sunday-based. */
function mondayOffset(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

export function periodFor(dateOnly: string, length: PeriodLength): Period {
  const ms = toUtc(dateOnly);

  if (length === "WEEKLY") {
    const start = ms - mondayOffset(ms) * DAY_MS;
    return { start: fromUtc(start), end: fromUtc(start + 6 * DAY_MS) };
  }

  if (length === "BIWEEKLY") {
    const weekStart = ms - mondayOffset(ms) * DAY_MS;
    // Floor to a 14-day block from the anchor. Math.floor (not truncation)
    // so dates BEFORE the anchor still land on a block boundary rather than
    // rounding toward it.
    const blocks = Math.floor((weekStart - BIWEEKLY_ANCHOR) / (14 * DAY_MS));
    const start = BIWEEKLY_ANCHOR + blocks * 14 * DAY_MS;
    return { start: fromUtc(start), end: fromUtc(start + 13 * DAY_MS) };
  }

  // SEMIMONTHLY — 1st–15th and 16th–end of month, the two halves payroll runs.
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (d.getUTCDate() <= 15) {
    return { start: fromUtc(Date.UTC(y, m, 1)), end: fromUtc(Date.UTC(y, m, 15)) };
  }
  // Day 0 of the NEXT month is the last day of this one — correct for 28/29/30/31
  // without a leap-year table.
  return {
    start: fromUtc(Date.UTC(y, m, 16)),
    end: fromUtc(Date.UTC(y, m + 1, 0)),
  };
}

/** Do two dates fall in the same period? Used to decide whether changing an
 *  entry's date REPARENTS it to a different timesheet. */
export function samePeriod(
  a: string,
  b: string,
  length: PeriodLength,
): boolean {
  return periodFor(a, length).start === periodFor(b, length).start;
}
