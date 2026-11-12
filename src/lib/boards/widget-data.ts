/**
 * The data contract between a DASHBOARD-family board and the widgets saved on
 * it, plus the readers that turn a builder-written `config` blob into something
 * a component can trust.
 *
 * WHY A BAG AND NOT PER-WIDGET FETCHES. `dashboard-view.tsx` already issues
 * eight queries and derives every aggregate on this screen from the FILTERED
 * item set. A widget that fetched for itself would (a) multiply those queries
 * by the number of tiles and (b) escape the board's filter bar — which is the
 * exact defect #683 fixed for the stock panels ("a dashboard that filtered
 * differently from the boards it summarises would be worse than one that does
 * not filter"). So the board computes once and hands the result down.
 *
 * Client-safe: no Prisma, no server-only imports. `src/lib/dashboards/panel-*`
 * is a separate, server-only panel engine (one consumer: the preview-panel
 * route) and cannot be reached from a `"use client"` view; the aggregations
 * reused here come from `src/lib/dashboard/*` instead, which the dashboard view
 * already imports.
 */
import {
  checkWidgetLinkTarget,
  MAX_WIDGET_LINKS,
  widgetLinkLines,
} from "./widget-links";
import type { BuilderWidget } from "@/types/models";

/** One categorical bucket — a bar or a slice. */
export interface WidgetSeriesPoint {
  name: string;
  value: number;
  /** Hex, when the source has an opinion (status/priority/work-type colours). */
  color?: string;
}

/** One observed day of a burndown. Mirrors `widgets/burndown-chart.tsx`. */
export interface WidgetTimePoint {
  date: string;
  ideal: number;
  actual: number;
}

/** A work item flattened to the columns a table or list widget can show. */
export interface WidgetItemRow {
  id: string;
  /** `PROJ-12` — the human reference, not the uuid. */
  key: string;
  title: string;
  /** The status COLUMN's display name, not its category. */
  status: string;
  /**
   * The status's workflow category — TODO, IN_PROGRESS, DONE or CANCELLED —
   * read from the same column map the Completed and In Progress counters use,
   * so a checklist tick and the Completed number cannot disagree.
   */
  statusCategory: string;
  priority: string;
  /** Display name, or "Unassigned". Never a bare user id. */
  assignee: string;
  /** ISO, or null. Formatting belongs to the widget. */
  dueDate: string | null;
  startDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** The work type's catalogue key (`bug`, `ops.incident`), when it has one. */
  typeKey: string | null;
  typeName: string | null;
  /**
   * The item's custom field values, keyed by field key, exactly as the
   * work-items route returned them. Only the AEC skins read it.
   */
  customFields: Record<string, unknown>;
}

/** Done or cancelled: no longer work anyone has to do. */
export function isClosedRow(row: Pick<WidgetItemRow, "statusCategory">): boolean {
  return row.statusCategory === "DONE" || row.statusCategory === "CANCELLED";
}

/** One finished sprint, as its report recorded it at close. */
export interface WidgetVelocityPoint {
  id: string;
  name: string;
  /** Story points finished. */
  completed: number;
  /** Story points the sprint held at close, or null on a report that predates it. */
  committed: number | null;
}

/** A sprint or other interval, for the timeline. */
export interface WidgetIntervalSpan {
  id: string;
  name: string;
  /** ISO. */
  startDate: string;
  endDate: string;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
}

/** The metrics a `counter` / `kpi-card` may point at. Order is palette order. */
export const WIDGET_METRICS = [
  { key: "total", label: "Total items" },
  { key: "completed", label: "Completed" },
  { key: "inProgress", label: "In progress" },
  { key: "overdue", label: "Overdue" },
] as const;

export type WidgetMetricKey = (typeof WIDGET_METRICS)[number]["key"];

/** The groupings a `bar-chart` may break the item set down by. */
export const WIDGET_GROUPS = [
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "type", label: "Work type" },
] as const;

export type WidgetGroupKey = (typeof WIDGET_GROUPS)[number]["key"];

/** Everything a widget on this board can read. Computed once, per render pass. */
export interface BoardWidgetData {
  /** `PROJ` — for links and the New work item form. */
  projectKey: string;
  metrics: Record<WidgetMetricKey, number>;
  series: Record<WidgetGroupKey, WidgetSeriesPoint[]>;
  /** The active interval's burndown. Empty when there is no active interval. */
  burndown: WidgetTimePoint[];
  /** The filtered items, flattened. Already in the board's own order. */
  rows: WidgetItemRow[];
  /**
   * Finished sprints, oldest first, from the reports written when each one
   * closed. NOT narrowed by the filter bar: a closed sprint's report is a
   * record of what that sprint held, not a view of today's items, which is
   * also how the board's own "Across time" view reads it.
   */
  velocity: WidgetVelocityPoint[];
  /** The project's sprints — not the increments that contain them. */
  intervals: WidgetIntervalSpan[];
}

/**
 * The nothing-to-show value, with a stable identity so a memo returning it
 * cannot churn its consumers.
 *
 * A board with no saved widgets renders the stock panels and never reads this,
 * so the host short-circuits to it rather than deriving a second work-type mix
 * and a row per filtered item on every dashboard in the product. Shared, and
 * therefore read-only by contract — every widget only reads, and none of them
 * is handed a reason to write.
 */
export const EMPTY_WIDGET_DATA: BoardWidgetData = {
  projectKey: "",
  metrics: { total: 0, completed: 0, inProgress: 0, overdue: 0 },
  series: { status: [], priority: [], assignee: [], type: [] },
  burndown: [],
  rows: [],
  velocity: [],
  intervals: [],
};

const METRIC_KEYS = WIDGET_METRICS.map((m) => m.key) as readonly string[];
const GROUP_KEYS = WIDGET_GROUPS.map((g) => g.key) as readonly string[];

/**
 * Which metric a widget's config asks for, defaulting to `total`.
 *
 * `config` is free-form JSON written by the builder, so it is validated rather
 * than cast: an unrecognised metric name would otherwise index the record with
 * `undefined` and render a blank where a number belongs.
 */
export function widgetMetricKey(
  config: Record<string, unknown>,
): WidgetMetricKey {
  const raw = config.metric;
  return typeof raw === "string" && METRIC_KEYS.includes(raw)
    ? (raw as WidgetMetricKey)
    : "total";
}

export function widgetMetricLabel(key: WidgetMetricKey): string {
  return WIDGET_METRICS.find((m) => m.key === key)!.label;
}

/** Which grouping a chart widget asks for, defaulting to `status`. */
export function widgetGroupKey(
  config: Record<string, unknown>,
): WidgetGroupKey {
  const raw = config.groupBy;
  return typeof raw === "string" && GROUP_KEYS.includes(raw)
    ? (raw as WidgetGroupKey)
    : "status";
}

export function widgetGroupLabel(key: WidgetGroupKey): string {
  return WIDGET_GROUPS.find((g) => g.key === key)!.label;
}

/** A row cap, clamped. The builder's number input accepts anything typed. */
export function widgetMaxItems(
  config: Record<string, unknown>,
  fallback = 10,
): number {
  const raw = config.maxItems;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(1, Math.trunc(n)));
}

/** A finite number from config, or null. Used for a KPI's target. */
export function widgetConfigNumber(
  config: Record<string, unknown>,
  key: string,
): number | null {
  const raw = config[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A non-empty string from config, or the fallback. */
export function widgetConfigText(
  config: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const raw = config[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : fallback;
}

/** The shares a gauge can show: the metric over the board's total. */
export const WIDGET_RATIOS = [
  { key: "completed", label: "Completed" },
  { key: "inProgress", label: "In progress" },
  { key: "overdue", label: "Overdue" },
] as const;

export type WidgetRatioKey = (typeof WIDGET_RATIOS)[number]["key"];

const RATIO_KEYS = WIDGET_RATIOS.map((r) => r.key) as readonly string[];

/** Which share a gauge shows, defaulting to `completed`. */
export function widgetRatioKey(config: Record<string, unknown>): WidgetRatioKey {
  const raw = config.metric;
  return typeof raw === "string" && RATIO_KEYS.includes(raw)
    ? (raw as WidgetRatioKey)
    : "completed";
}

/** A day count from config, clamped to 7–365. Used for the area chart's window. */
export function widgetDays(config: Record<string, unknown>, fallback = 30): number {
  const raw = config.days;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(7, Math.trunc(n)));
}

/** One entry of a Link List. */
export interface WidgetLink {
  label: string;
  href: string;
  /** Leaves the app: opens in a new tab, with no opener and no referrer. */
  external: boolean;
}

/**
 * The links a Link List draws: every line that passes the shared rule in
 * `widget-links.ts` (http(s), or an in-app path that provably stays in the
 * app), as its normalised href. A line that fails is dropped rather than drawn
 * as a dead link — and cannot be saved in the first place, because the save
 * routes run the same rule (`widgetLinkProblems`).
 *
 * `origin` is the viewer's `location.origin` when there is one.
 */
export function widgetLinks(config: Record<string, unknown>, origin?: string): WidgetLink[] {
  const raw = config.links;
  if (typeof raw !== "string") return [];
  const out: WidgetLink[] = [];
  for (const l of widgetLinkLines(raw)) {
    const check = checkWidgetLinkTarget(l.target, origin);
    if (!check.ok) continue;
    out.push({ label: l.label, href: check.href, external: check.external });
    if (out.length >= MAX_WIDGET_LINKS) break;
  }
  return out;
}

/**
 * The rows grouped by one of the board's groupings, in a stable order: the
 * order the series already uses (so a grouped list and a bar chart of the same
 * grouping list their buckets alike), then any group the series did not name.
 */
export function groupRows(
  rows: WidgetItemRow[],
  group: WidgetGroupKey,
  order: readonly string[] = [],
): Array<{ name: string; rows: WidgetItemRow[] }> {
  const pick = (r: WidgetItemRow): string => {
    switch (group) {
      case "status":
        return r.status;
      case "priority":
        return r.priority;
      case "assignee":
        return r.assignee;
      case "type":
        return r.typeName ?? "No type";
    }
  };
  const buckets = new Map<string, WidgetItemRow[]>();
  for (const name of order) buckets.set(name, []);
  for (const r of rows) {
    const name = pick(r);
    const bucket = buckets.get(name);
    if (bucket) bucket.push(r);
    else buckets.set(name, [r]);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([name, list]) => ({ name, rows: list }));
}

/**
 * The widgets a board has saved, read defensively out of `Board.config`.
 *
 * `Board.config` is an untyped JSON column written by several surfaces (the
 * builder, "Save as board", the TIMELINE mode seed, a Table's `typeKeys`), so
 * this cannot assume `widgets` is an array of well-formed objects — and a throw
 * here would take the whole board down, not just one tile. Anything it cannot
 * make sense of is dropped, and a board left with nothing falls back to the
 * stock panels exactly as before.
 */
export function readBuilderWidgets(config: unknown): BuilderWidget[] {
  if (!config || typeof config !== "object") return [];
  const raw = (config as { widgets?: unknown }).widgets;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: BuilderWidget[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    if (typeof w.id !== "string" || w.id.length === 0) continue;
    if (typeof w.type !== "string" || w.type.length === 0) continue;
    // A duplicate id would give react-grid-layout two children with the same
    // key, which React resolves by dropping one — silently losing a tile.
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({
      id: w.id,
      type: w.type,
      config:
        w.config && typeof w.config === "object" && !Array.isArray(w.config)
          ? (w.config as Record<string, unknown>)
          : {},
      layout: normalizeLayout(w.layout),
    });
  }
  return out;
}

/**
 * A grid cell the layout engine can place.
 *
 * Width and height are clamped to at least 1 because react-grid-layout gives a
 * 0-or-missing dimension a 1x1 cell at the origin, where it collapses to an
 * unreadable sliver stacked under whatever else landed there — the exact way
 * "Blocked Work" and "Work Type Mix" reached production looking broken (see
 * `DEFAULT_LAYOUTS` in `dashboard-view.tsx`). `w` is also capped at the grid's
 * 12 columns: a wider tile is drawn off the right edge of the container.
 */
export function normalizeLayout(layout: unknown): BuilderWidget["layout"] {
  const l = (layout ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  };
  return {
    x: Math.min(11, Math.max(0, num(l.x, 0))),
    y: Math.max(0, num(l.y, 0)),
    w: Math.min(12, Math.max(1, num(l.w, 4))),
    h: Math.max(1, num(l.h, 3)),
  };
}

/** Reading order for the mobile stack: top-to-bottom, then left-to-right. */
export function byGridPosition(a: BuilderWidget, b: BuilderWidget): number {
  return a.layout.y - b.layout.y || a.layout.x - b.layout.x;
}
