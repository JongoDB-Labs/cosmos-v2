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
  priority: string;
  /** Display name, or "Unassigned". Never a bare user id. */
  assignee: string;
  /** ISO, or null. Formatting belongs to the widget. */
  dueDate: string | null;
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
  metrics: Record<WidgetMetricKey, number>;
  series: Record<WidgetGroupKey, WidgetSeriesPoint[]>;
  /** The active interval's burndown. Empty when there is no active interval. */
  burndown: WidgetTimePoint[];
  /** The filtered items, flattened. Already in the board's own order. */
  rows: WidgetItemRow[];
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
  metrics: { total: 0, completed: 0, inProgress: 0, overdue: 0 },
  series: { status: [], priority: [], assignee: [], type: [] },
  burndown: [],
  rows: [],
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
