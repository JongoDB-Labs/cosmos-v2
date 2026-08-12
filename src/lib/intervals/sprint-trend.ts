/**
 * Sprint Health across TIME, rather than only the sprint in flight.
 *
 * The board showed the active sprint and nothing else, so the two questions a
 * team asks between ceremonies — "are we getting faster or slower?" and "how is
 * the increment as a whole doing?" — had no answer in the product. Both are
 * already recorded: completing a sprint writes velocity and counts to
 * `intervals.report`.
 *
 * Read defensively. `report` is a JSON column, so nothing below the application
 * guarantees its shape, and a sprint completed before those fields existed has
 * none of them.
 */

export interface TrendIntervalLike {
  id: string;
  number: number;
  name: string;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  parentId: string | null;
  report: unknown;
}

export interface SprintTrendPoint {
  id: string;
  number: number;
  name: string;
  velocity: number;
  completedItems: number;
  totalItems: number;
  /** Completed ÷ total, as a whole percentage. 0 when the sprint held nothing. */
  completionPct: number;
}

interface ParsedReport {
  velocity: number;
  completedItems: number;
  totalItems: number;
}

/**
 * A report is usable only if it actually carries a numeric velocity. A sprint
 * completed before that was recorded gets skipped rather than plotted as zero:
 * "no velocity" and "zero velocity" are different facts, and a zero on the chart
 * tells a story about the team the data does not support.
 */
function parseReport(report: unknown): ParsedReport | null {
  if (report === null || typeof report !== "object") return null;
  const r = report as Record<string, unknown>;
  if (typeof r.velocity !== "number" || !Number.isFinite(r.velocity)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    velocity: r.velocity,
    completedItems: num(r.completedItems),
    totalItems: num(r.totalItems),
  };
}

/** One point per finished sprint, oldest first — a trend read backwards is not one. */
export function sprintTrend(intervals: TrendIntervalLike[]): SprintTrendPoint[] {
  return intervals
    .filter((i) => i.status === "COMPLETED")
    .map((i) => ({ interval: i, report: parseReport(i.report) }))
    .filter((x): x is { interval: TrendIntervalLike; report: ParsedReport } => x.report !== null)
    .sort((a, b) => a.interval.number - b.interval.number)
    .map(({ interval, report }) => ({
      id: interval.id,
      number: interval.number,
      name: interval.name,
      velocity: report.velocity,
      completedItems: report.completedItems,
      totalItems: report.totalItems,
      completionPct:
        report.totalItems > 0
          ? Math.round((report.completedItems / report.totalItems) * 100)
          : 0,
    }));
}

export interface PiRollup {
  velocity: number;
  completedItems: number;
  totalItems: number;
  sprintsCompleted: number;
  averageVelocity: number;
  completionPct: number;
  sprints: SprintTrendPoint[];
}

/** Everything finished inside one Program Increment, added up. */
export function piRollup(
  pi: { id: string },
  intervals: TrendIntervalLike[],
): PiRollup {
  const sprints = sprintTrend(intervals.filter((i) => i.parentId === pi.id));

  const velocity = sprints.reduce((s, p) => s + p.velocity, 0);
  const completedItems = sprints.reduce((s, p) => s + p.completedItems, 0);
  const totalItems = sprints.reduce((s, p) => s + p.totalItems, 0);

  return {
    velocity,
    completedItems,
    totalItems,
    sprintsCompleted: sprints.length,
    // Guarded: an increment with nothing finished yet is the normal state at its
    // start, not an error.
    averageVelocity: sprints.length > 0 ? Math.round(velocity / sprints.length) : 0,
    completionPct: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    sprints,
  };
}
