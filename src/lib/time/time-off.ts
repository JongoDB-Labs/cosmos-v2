/**
 * Time off occupies WORKING days, and a week's total is derived, never stored.
 *
 * A request is a range plus a per-day figure, so the hours it consumes in any
 * particular week have to be computed from the overlap. Storing a total instead
 * would go stale the moment somebody moved a date — and the staffing board,
 * which is the whole reason these hours are counted, asks the question one week
 * at a time.
 *
 * Weekends are excluded because nobody takes leave from a day they were not
 * working: a Friday-to-Monday break is two days away, not four. Public holidays
 * are not excluded here — they are themselves TimeOffRequests of kind HOLIDAY,
 * so subtracting them again would count the closure twice.
 */

const DAY_MS = 86_400_000;

const at = (dateOnly: string) => Date.parse(`${dateOnly}T00:00:00.000Z`);

/** Saturday or Sunday, read in UTC: these are date-only values, not instants. */
export function isWeekend(dateOnly: string): boolean {
  const day = new Date(at(dateOnly)).getUTCDay();
  return day === 0 || day === 6;
}

/** Working days in an INCLUSIVE range. Zero when the range runs backwards. */
export function workingDaysBetween(startDate: string, endDate: string): number {
  const from = at(startDate);
  const to = at(endDate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return 0;
  let days = 0;
  for (let t = from; t <= to; t += DAY_MS) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
  }
  return days;
}

export type LeaveRange = {
  startDate: string;
  endDate: string;
  hoursPerDay: number;
};

/**
 * Hours of leave falling inside an inclusive window — a week, a month, a year.
 *
 * Clamps to the overlap rather than asking whether the request "is in" the
 * window: a fortnight off spans three weeks and owes each of them only its own
 * days, so a containment test would give one week everything and the other two
 * nothing.
 */
export function hoursInWindow(
  leave: LeaveRange,
  windowStart: string,
  windowEnd: string,
): number {
  const from = leave.startDate > windowStart ? leave.startDate : windowStart;
  const to = leave.endDate < windowEnd ? leave.endDate : windowEnd;
  return workingDaysBetween(from, to) * leave.hoursPerDay;
}

/** Total hours a request consumes over its whole range. */
export function totalHours(leave: LeaveRange): number {
  return workingDaysBetween(leave.startDate, leave.endDate) * leave.hoursPerDay;
}

/**
 * Statuses that reserve capacity.
 *
 * PENDING counts. A request nobody has decided on yet is still a person telling
 * you they intend to be away, and a staffing board that only showed approved
 * leave would show a team as available right up until the moment it was too
 * late to do anything about it.
 */
export const RESERVES_CAPACITY = ["PENDING", "APPROVED"] as const;
