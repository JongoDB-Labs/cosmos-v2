/**
 * Every number a DASHBOARD-family board shows, derived in one place.
 *
 * `dashboard-view.tsx` used to compute these inline in its own `useMemo`s, and
 * then compute the bag its saved widgets read from the results. That made the
 * view the only thing that could produce a widget's input — so the only way to
 * test a widget against real data was to mount the whole board. Pulled out as
 * plain functions, the stock panels and the widget bag call the same code, and
 * a test can feed the bag from what the REAL work-items route returned (see
 * `widgets/all-widgets.db.test.tsx`).
 *
 * Client-safe: no Prisma, no server-only imports.
 */
import type { BoardColumn, Interval, OrgMember, WorkItem } from "@/types/models";
import { burndown } from "@/lib/intervals/burndown";
import { defaultCeremonyInterval } from "@/lib/intervals/ceremony-intervals";
import { isProgramIncrement } from "@/lib/intervals/pi-lifecycle";
import { sprintTrend } from "@/lib/intervals/sprint-trend";
import { workTypeMix } from "@/lib/dashboard/delivery-metrics";
import type {
  BoardWidgetData,
  WidgetIntervalSpan,
  WidgetMetricKey,
  WidgetSeriesPoint,
  WidgetTimePoint,
  WidgetVelocityPoint,
} from "@/lib/boards/widget-data";
import { assigneeLabel, workloadBuckets } from "./workload";
import { toDeliveryItems } from "./delivery-panels";

export const CATEGORY_COLORS: Record<string, string> = {
  TODO: "#6b7280",
  IN_PROGRESS: "#3b82f6",
  DONE: "#22c55e",
  CANCELLED: "#ef4444",
};

export const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#3b82f6",
  LOW: "#6b7280",
};

/** Status key → workflow category. */
export function categoryMapOf(columns: BoardColumn[]): Map<string, string> {
  return new Map(columns.map((c) => [c.key, c.category]));
}

/** User id → display name, falling back to the email, then "Unknown". */
export function memberNamesOf(members: OrgMember[]): Map<string, string> {
  return new Map(
    members.map((m) => [m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown"]),
  );
}

/** The four headline counts. `now` is passed in so one pass uses one instant. */
export function dashboardMetrics(
  items: WorkItem[],
  categories: Map<string, string>,
  now: Date,
): Record<WidgetMetricKey, number> {
  let completed = 0;
  let inProgress = 0;
  let overdue = 0;
  for (const i of items) {
    const cat = categories.get(i.columnKey);
    if (cat === "DONE") completed += 1;
    if (cat === "IN_PROGRESS") inProgress += 1;
    if (i.dueDate && !i.completedAt && new Date(i.dueDate) < now) overdue += 1;
  }
  return { total: items.length, completed, inProgress, overdue };
}

/** Items per workflow category, in first-seen order. */
export function statusSeries(
  items: WorkItem[],
  categories: Map<string, string>,
): Array<Required<WidgetSeriesPoint>> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const cat = categories.get(item.columnKey) ?? "TODO";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return Object.entries(counts).map(([name, value]) => ({
    name: name.replace("_", " "),
    value,
    color: CATEGORY_COLORS[name] ?? "#6b7280",
  }));
}

/** Items per priority, always all four buckets, most urgent first. */
export function prioritySeries(items: WorkItem[]): Array<Required<WidgetSeriesPoint>> {
  const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const item of items) {
    counts[item.priority] = (counts[item.priority] ?? 0) + 1;
  }
  return Object.entries(counts).map(([name, value]) => ({
    name: titleCase(name),
    value,
    color: PRIORITY_COLORS[name] ?? "#6b7280",
  }));
}

/**
 * The burndown of the sprint in flight, via the SHARED computation.
 *
 * NOT `.find(s => s.status === "ACTIVE")`: a Program Increment is ACTIVE for as
 * long as any sprint inside it runs, and the API orders it above its sprints,
 * so that find returns the PI — which holds no work of its own. Same picker as
 * the ceremony boards.
 */
export function activeBurndown(
  items: WorkItem[],
  intervals: Interval[],
  categories: Map<string, string>,
  today: Date,
): WidgetTimePoint[] {
  const active = defaultCeremonyInterval(intervals);
  if (!active) return [];

  const series = burndown({
    start: new Date(active.startDate),
    end: new Date(active.endDate),
    today,
    unit: "count",
    items: items
      .filter((i) => i.intervalId === active.id)
      .map((i) => ({
        id: i.id,
        storyPoints: i.storyPoints ?? null,
        completedAt: i.completedAt ?? null,
        done: categories.get(i.columnKey) === "DONE",
      })),
  });

  // An interval with nothing in it has no burndown to draw — empty, so the
  // chart shows its "no data" state rather than a misleading flat zero line.
  if (series.scope === 0) return [];

  // Only observed days; the module returns nulls past today precisely so no
  // caller can chart the future.
  return series.points
    .filter((p) => !p.isFuture)
    .map((p) => ({
      date: new Date(`${p.date}T00:00:00`).toLocaleDateString("default", {
        month: "short",
        day: "numeric",
      }),
      ideal: Math.round(p.ideal),
      actual: p.remaining ?? 0,
    }));
}

/**
 * Committed points as the sprint report recorded them at close.
 *
 * `report` is a JSON column, so nothing below the application guarantees its
 * shape; a sprint closed before `totalStoryPoints` was recorded has none, and
 * "not recorded" must not be drawn as zero.
 */
function committedPointsOf(report: unknown): number | null {
  if (report === null || typeof report !== "object") return null;
  const v = (report as Record<string, unknown>).totalStoryPoints;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Finished sprints, oldest first, through the same reader "Across time" uses. */
export function velocityOf(intervals: Interval[]): WidgetVelocityPoint[] {
  const reportOf = new Map(intervals.map((i) => [i.id, i.report]));
  return sprintTrend(intervals).map((p) => ({
    id: p.id,
    name: p.name,
    completed: p.velocity,
    committed: committedPointsOf(reportOf.get(p.id)),
  }));
}

/**
 * The project's sprints for the timeline: every interval except a Program
 * Increment, which CONTAINS sprints and would draw over them.
 */
export function sprintSpansOf(intervals: Interval[]): WidgetIntervalSpan[] {
  return intervals
    .filter((i) => !isProgramIncrement(i.intervalKind))
    .map((i) => ({
      id: i.id,
      name: i.name,
      startDate: i.startDate,
      endDate: i.endDate,
      status: i.status,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function titleCase(upper: string): string {
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

export interface WidgetDataInput {
  /** The board's FILTERED items — what the filter bar left on screen. */
  items: WorkItem[];
  /** The workflow that describes them (the board's own, else the project's). */
  columns: BoardColumn[];
  members: OrgMember[];
  intervals: Interval[];
  projectKey: string;
  now: Date;
}

/**
 * Everything a saved widget may read, from the SAME filtered set the stock
 * panels use — so the filter bar narrows a custom layout exactly as it narrows
 * the default one, and every number comes from a route that already gated it.
 */
export function deriveBoardWidgetData(input: WidgetDataInput): BoardWidgetData {
  const { items, columns, members, intervals, projectKey, now } = input;
  const categories = categoryMapOf(columns);
  const names = memberNamesOf(members);
  const columnName = new Map(columns.map((c) => [c.key, c.name]));

  return {
    projectKey,
    metrics: dashboardMetrics(items, categories, now),
    series: {
      status: statusSeries(items, categories),
      priority: prioritySeries(items),
      assignee: workloadBuckets(items, names).map((w) => ({
        name: w.name,
        value: w.items,
      })),
      // The SHARED work-type aggregation the stock "Work Type Mix" panel uses —
      // not a second count, which is how two numbers on one screen disagree.
      type: workTypeMix(toDeliveryItems(items, columns)).byType.map((t) => ({
        name: t.name,
        value: t.count,
        color: t.color ?? undefined,
      })),
    },
    burndown: activeBurndown(items, intervals, categories, now),
    rows: items.map((i) => ({
      id: i.id,
      key: `${projectKey}-${i.ticketNumber}`,
      title: i.title,
      // The column's display NAME, not its category: "In Review" is what the
      // project calls it, and the category would collapse three columns into
      // one word.
      status: columnName.get(i.columnKey) ?? i.columnKey,
      columnKey: i.columnKey,
      statusCategory: categories.get(i.columnKey) ?? "TODO",
      priority: titleCase(i.priority),
      assignee: assigneeLabel(i, names) ?? "Unassigned",
      dueDate: i.dueDate,
      startDate: i.startDate ?? null,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      completedAt: i.completedAt ?? null,
      typeKey: i.workItemType?.key ?? null,
      typeName: i.workItemType?.name ?? null,
      customFields:
        i.customFields && typeof i.customFields === "object" ? i.customFields : {},
    })),
    velocity: velocityOf(intervals),
    intervals: sprintSpansOf(intervals),
  };
}
