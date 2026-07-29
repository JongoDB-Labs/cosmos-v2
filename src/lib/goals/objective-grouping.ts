/**
 * Group a project's objectives under the interval each is committed to, for the
 * Goals / Objectives board.
 *
 * The ordering rule is the one the Backlog planner uses (ACTIVE, then PLANNED,
 * then COMPLETED; by start date within a status), so the two planning surfaces
 * present a project's timeboxes in the same order.
 */

export interface PanelObjective {
  id: string;
  title: string;
  progress: number;
  committed: boolean;
  intervalId: string | null;
}

export interface PanelInterval {
  id: string;
  name: string;
  goal?: string | null;
  status: "ACTIVE" | "PLANNED" | "COMPLETED";
  startDate?: string | null;
}

export interface ObjectiveGroup {
  /** Interval id, or `__none__` for objectives not tied to a timebox. */
  key: string;
  label: string;
  /** The interval's own goal — a sprint goal / PI theme. Null when untimeboxed. */
  intervalGoal: string | null;
  objectives: PanelObjective[];
  committedCount: number;
}

export const NO_INTERVAL = "__none__";

const STATUS_RANK: Record<PanelInterval["status"], number> = {
  ACTIVE: 0,
  PLANNED: 1,
  COMPLETED: 2,
};

export function groupObjectivesByInterval(
  objectives: PanelObjective[],
  intervals: PanelInterval[],
): ObjectiveGroup[] {
  const byInterval = new Map<string, PanelObjective[]>();
  for (const o of objectives) {
    const key = o.intervalId ?? NO_INTERVAL;
    const arr = byInterval.get(key);
    if (arr) arr.push(o);
    else byInterval.set(key, [o]);
  }

  const intervalById = new Map(intervals.map((c) => [c.id, c]));

  // An interval with a goal but no objectives still gets a group: the sprint
  // goal IS the thing worth showing, and hiding it until someone writes an
  // objective would keep it buried in interval settings — which is the reason
  // it wasn't visible in the first place.
  for (const c of intervals) {
    if (c.goal && c.goal.trim() && !byInterval.has(c.id)) byInterval.set(c.id, []);
  }

  const groups: ObjectiveGroup[] = [];
  for (const [key, objs] of byInterval) {
    const interval = key === NO_INTERVAL ? null : intervalById.get(key);
    groups.push({
      key,
      // An objective pointing at an interval we can't resolve (deleted, or one
      // the user can't read) still gets a home — never dropped silently.
      label:
        key === NO_INTERVAL
          ? "Not in an interval"
          : (interval?.name ?? "Unknown interval"),
      intervalGoal: interval?.goal?.trim() ? interval.goal : null,
      objectives: objs,
      committedCount: objs.filter((o) => o.committed).length,
    });
  }

  return groups.sort((a, b) => {
    // Untimeboxed objectives sort last: they're the leftovers, not the plan.
    if (a.key === NO_INTERVAL) return 1;
    if (b.key === NO_INTERVAL) return -1;
    const ai = intervalById.get(a.key);
    const bi = intervalById.get(b.key);
    if (ai && bi) {
      const sr = STATUS_RANK[ai.status] - STATUS_RANK[bi.status];
      if (sr !== 0) return sr;
      return (ai.startDate ?? "").localeCompare(bi.startDate ?? "");
    }
    if (ai) return -1;
    if (bi) return 1;
    return a.key.localeCompare(b.key);
  });
}
