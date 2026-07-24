/**
 * Sprint-planning math (pure). Powers the Start Sprint planning flow: resolving
 * the project's capacity unit, per-member capacity/availability, the running
 * team total, and the committed-scope vs capacity indicator.
 *
 * The capacity unit is project-type dependent:
 *   - software / agile projects plan in STORY POINTS (the board's points model);
 *   - architecture & engineering (and every other non-software sector) plan in
 *     HOURS, the guiding capacity metric for that work.
 *
 * All I/O (loading members, history, committed items) lives in the planning API
 * route; this module only does the arithmetic so it can be unit-tested.
 */

export type CapacityUnit = "points" | "hours";

/** Software / agile projects plan in story points; everything else in hours. */
export function capacityUnitForSector(
  sector: string | null | undefined,
): CapacityUnit {
  return sector === "software" ? "points" : "hours";
}

/** Short unit label for compact UI (e.g. next to an input). */
export function unitAbbrev(unit: CapacityUnit): string {
  return unit === "points" ? "pts" : "hrs";
}

/** Full unit noun for prose/labels. */
export function unitNoun(unit: CapacityUnit): string {
  return unit === "points" ? "story points" : "hours";
}

/** Sensible constants when a member has no sprint history to derive from. */
export const DEFAULT_POINTS_CAPACITY = 8;
export const DEFAULT_HOURS_CAPACITY = 60;

/** Clamp an availability percentage into 0..100. Non-finite → 100 (full). */
export function clampAvailability(pct: number): number {
  if (!Number.isFinite(pct)) return 100;
  return Math.min(100, Math.max(0, pct));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Effective capacity = base × availability%, rounded to one decimal. */
export function effectiveCapacity(base: number, availabilityPct: number): number {
  const b = Number.isFinite(base) && base > 0 ? base : 0;
  return round1(b * (clampAvailability(availabilityPct) / 100));
}

export interface CapacityRow {
  base: number;
  availabilityPct: number;
}

/** Team capacity = sum of every member's effective capacity. */
export function teamCapacity(rows: CapacityRow[]): number {
  return round1(
    rows.reduce((t, r) => t + effectiveCapacity(r.base, r.availabilityPct), 0),
  );
}

/**
 * Suggested per-member base capacity. Hours-based projects use the standard
 * hours/sprint constant; points-based projects average the member's completed
 * points across their most recent sprints (up to 3). Falls back to a sensible
 * constant when there is no history.
 *
 * @param recentCompletedPoints one completed-points total per recent sprint,
 *        most-recent first.
 */
export function suggestMemberCapacity(
  unit: CapacityUnit,
  recentCompletedPoints: number[],
): number {
  if (unit === "hours") return DEFAULT_HOURS_CAPACITY;
  const recent = recentCompletedPoints.slice(0, 3);
  if (recent.length === 0) return DEFAULT_POINTS_CAPACITY;
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  return Math.round(avg);
}

export interface SizedItem {
  storyPoints?: number | null;
  /** Original estimate in SECONDS (Jira's worklog unit), for hours projects. */
  originalEstimate?: number | null;
}

/** The planning size of a work item in the given unit. */
export function itemSize(item: SizedItem, unit: CapacityUnit): number {
  if (unit === "points") return item.storyPoints ?? 0;
  return round1((item.originalEstimate ?? 0) / 3600);
}

/** Running committed-scope total across the sprint's items. */
export function committedTotal(items: SizedItem[], unit: CapacityUnit): number {
  return round1(items.reduce((t, i) => t + itemSize(i, unit), 0));
}

/** Committed scope exceeds a positive team capacity → over-committed. */
export function isOverCommitted(committed: number, capacity: number): boolean {
  return capacity > 0 && committed > capacity;
}
