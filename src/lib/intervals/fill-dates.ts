/**
 * Interval → planned dates (COSMOS-223).
 *
 * Picking an interval (sprint / PI) fills an item's planned start and end from
 * the interval's dates, but ONLY where the item has none: a date someone
 * already set is a decision, and choosing an interval must never overwrite it.
 * Dates are calendar days ("YYYY-MM-DD"), the shape the date pickers hold.
 */
export interface PlannedDays {
  startDate: string;
  dueDate: string;
}

export function datesFromInterval(
  current: PlannedDays,
  interval:
    | { startDate?: string | null; endDate?: string | null }
    | null
    | undefined,
): Partial<PlannedDays> {
  if (!interval) return {};
  const fill: Partial<PlannedDays> = {};
  if (!current.startDate && interval.startDate)
    fill.startDate = interval.startDate.slice(0, 10);
  if (!current.dueDate && interval.endDate)
    fill.dueDate = interval.endDate.slice(0, 10);
  return fill;
}

/** A calendar day as the API's planned-date value (UTC midnight), like the pickers send. */
export function plannedDayToIso(day: string): string {
  return new Date(`${day}T00:00:00Z`).toISOString();
}
