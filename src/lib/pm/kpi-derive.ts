import type { Kpi, KpiAutoSource } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * KPI derivation — a KPI's currentValue can "trickle up" from execution (work
 * items + cycles) instead of being typed in. Opt-in per KPI via `autoSource`
 * (default MANUAL). Computed on read; never persisted. Shared by the KPIs API
 * and the PM Dashboard so they agree.
 */
const DONE_COLUMN = "done";
const DEFAULT_WINDOW_DAYS = 30;

export interface ExecutionMetrics {
  completionPct: number; // % of work items done
  velocity: number; // avg story points delivered per completed cycle
  openItems: number; // count of not-done work items
  avgCycleTime: number; // avg days from start to done (done items)
  throughput: (windowDays: number) => number; // items completed within the window
}

/** Compute a project's (or org-wide) execution metrics in a couple of queries. */
export async function computeExecutionMetrics(
  orgId: string,
  projectId: string | undefined,
  now: Date,
): Promise<ExecutionMetrics> {
  const where = projectId ? { orgId, projectId } : { orgId };
  const [items, completedCycles] = await Promise.all([
    prisma.workItem.findMany({
      where,
      select: {
        columnKey: true,
        storyPoints: true,
        cycleId: true,
        startDate: true,
        completedAt: true,
      },
    }),
    prisma.cycle.count({ where: { ...where, status: "COMPLETED" } }),
  ]);

  const total = items.length;
  const done = items.filter((i) => i.columnKey === DONE_COLUMN);
  const completionPct = total > 0 ? Math.round((done.length / total) * 100) : 0;
  const openItems = total - done.length;

  // Velocity: story points of done items that belong to a cycle, averaged over
  // the completed cycles (avg delivered per sprint).
  const cyclePoints = done
    .filter((i) => i.cycleId)
    .reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const velocity =
    completedCycles > 0 ? Math.round(cyclePoints / completedCycles) : cyclePoints;

  // Avg cycle time (days) for done items that carry both a start and a finish.
  const timed = done.filter((i) => i.startDate && i.completedAt);
  const avgCycleTime =
    timed.length > 0
      ? Math.round(
          timed.reduce(
            (sum, i) =>
              sum + (i.completedAt!.getTime() - i.startDate!.getTime()) / 86_400_000,
            0,
          ) / timed.length,
        )
      : 0;

  const throughput = (windowDays: number) => {
    const cutoff = now.getTime() - windowDays * 86_400_000;
    return done.filter((i) => i.completedAt && i.completedAt.getTime() >= cutoff).length;
  };

  return { completionPct, velocity, openItems, avgCycleTime, throughput };
}

/**
 * The derived currentValue for a KPI given its source + the execution metrics.
 * Returns null for MANUAL so the caller keeps the stored value.
 */
export function applyKpiAutoValue(
  source: KpiAutoSource,
  windowDays: number | null,
  m: ExecutionMetrics,
): number | null {
  switch (source) {
    case "VELOCITY":
      return m.velocity;
    case "COMPLETION_PCT":
      return m.completionPct;
    case "OPEN_ITEMS":
      return m.openItems;
    case "AVG_CYCLE_TIME":
      return m.avgCycleTime;
    case "THROUGHPUT":
      return m.throughput(windowDays ?? DEFAULT_WINDOW_DAYS);
    case "MANUAL":
    default:
      return null;
  }
}

export type DerivedKpi = Kpi & { derived: boolean };

/**
 * Load KPIs with auto-source values derived from execution. Metrics are computed
 * once and shared across every auto KPI; skipped entirely when none are auto.
 */
export async function loadKpisWithDerived(
  orgId: string,
  projectId?: string,
): Promise<DerivedKpi[]> {
  const kpis = await prisma.kpi.findMany({
    where: projectId ? { orgId, projectId } : { orgId },
    orderBy: { sortOrder: "asc" },
  });

  if (!kpis.some((k) => k.autoSource !== "MANUAL")) {
    return kpis.map((k) => ({ ...k, derived: false }));
  }

  const metrics = await computeExecutionMetrics(orgId, projectId, new Date());
  return kpis.map((k) => {
    const v = applyKpiAutoValue(k.autoSource, k.autoWindowDays, metrics);
    return v === null ? { ...k, derived: false } : { ...k, currentValue: v, derived: true };
  });
}
