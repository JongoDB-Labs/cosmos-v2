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
 * to `targetDate`. Without a usable window it stays on_track while time remains.
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

  const target = new Date(targetDate).getTime();
  if (Number.isNaN(target)) return "no_date";
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

export const HEALTH_LABEL: Record<ObjectiveHealth, string> = {
  done: "Done",
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
  no_date: "No target date",
};
