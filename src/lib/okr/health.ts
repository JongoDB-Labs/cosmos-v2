/**
 * Objective health (FR a94ff583): a stoplight derived from PROGRESS vs. TIME.
 *
 *   - done     : the objective is complete (progress ≥ 100 or status COMPLETED)
 *   - no_date  : no target date, so there's no pacing signal to judge
 *   - behind   : past the target date and not done, or progress well below the
 *                pace implied by time elapsed
 *   - at_risk  : progress trails the expected pace by a moderate margin
 *   - on_track : progress keeps up with (or leads) the elapsed time
 *
 * Pace uses the window from `startDate` (the objective's creation, as a proxy)
 * to the end of the due day. Without a usable window it stays on_track while
 * time remains.
 *
 * A target date is a CALENDAR DAY. The board sets it as UTC midnight and shows
 * it pinned to UTC, so an objective due Nov 13 is due until Nov 13 ends (UTC),
 * not from the first minute of it.
 */
export type ObjectiveHealth = "done" | "on_track" | "at_risk" | "behind" | "no_date";

export function objectiveHealth(
  progress: number,
  targetDate: Date | string | number | null | undefined,
  status: string,
  startDate?: Date | string | number | null,
  now: number = Date.now(),
): ObjectiveHealth {
  if (status === "COMPLETED" || progress >= 100) return "done";
  if (!targetDate) return "no_date";

  const target = dueEndsAt(targetDate);
  if (target === null) return "no_date";
  if (now >= target) return "behind"; // past due, not complete

  const start = startDate ? new Date(startDate).getTime() : NaN;
  if (!Number.isNaN(start) && target > start && now >= start) {
    const elapsed = (now - start) / (target - start); // 0..1
    const expected = elapsed * 100;
    if (progress >= expected - 5) return "on_track";
    if (progress >= expected - 20) return "at_risk";
    return "behind";
  }

  // No usable start window — time still remains, so treat as on track.
  return "on_track";
}

const DAY_MS = 86_400_000;

/** The instant a target date has passed: the end of its calendar day (UTC). Null for no usable date. */
export function dueEndsAt(targetDate: Date | string | number | null | undefined): number | null {
  if (targetDate === null || targetDate === undefined || targetDate === "") return null;
  const t = new Date(targetDate).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
}

/**
 * Past its target date and not finished. A completed or cancelled objective is
 * never overdue; a draft or active one is once its due day has ended.
 */
export function isOverdue(
  progress: number,
  targetDate: Date | string | number | null | undefined,
  status: string,
  now: number = Date.now(),
): boolean {
  if (status === "COMPLETED" || status === "CANCELLED" || progress >= 100) return false;
  const end = dueEndsAt(targetDate);
  return end !== null && now >= end;
}

export const HEALTH_LABEL: Record<ObjectiveHealth, string> = {
  done: "Done",
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
  no_date: "No target date",
};
