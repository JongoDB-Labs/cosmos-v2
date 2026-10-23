/**
 * The dashboard panel catalog (dashboards design §5.1, §5.2): every panel
 * type, what it needs and how its config is shaped. Client-safe: the editor
 * builds its forms from it and renderers look up sizes; the server computes
 * live in panel-compute.server.ts, keyed by the same types (a test asserts
 * every type here has one).
 *
 * A panel's data is always computed AS THE VIEWER, from the panel's CQL query
 * ANDed with the dashboard's filters. Nothing here can widen what a viewer
 * sees; it only shapes it.
 */
import { z } from "zod";
import { aggFieldSchema as fieldRef, aggMeasureSchema } from "@/lib/query/aggregate";

export type PanelCategory = "list" | "number" | "chart" | "flow" | "context";

export interface PanelSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export interface PanelTypeDef<C extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;
  label: string;
  category: PanelCategory;
  description: string;
  config: C;
  size: PanelSize;
  /** Takes a CQL query (with the dashboard filters). */
  needsQuery: boolean;
  /** A slice, bar, cell or number opens the items behind it. */
  supportsDrill: boolean;
  /** Needs a sprint: the `sprint` filter, else the context project's active sprint. */
  needsSprint?: boolean;
}

/** List row cap (design §5.2 limits). */
export const LIST_MAX = 100;
/** Panels per dashboard. */
export const PANELS_MAX = 40;

const limit = (d: number) => z.number().int().min(1).max(LIST_MAX).default(d);
const rel = z.string().regex(/^-\d{1,4}(d|w|M|wd)$/, "A window such as -7d, -2w, -1M or -5wd.");
const tone = z.enum(["good", "warning", "danger", "neutral"]);
const measure = aggMeasureSchema.default({ fn: "count" });
const ITEM_COLUMNS = ["key", "title", "type", "status", "assignee", "priority", "due", "sprint", "points", "labels", "updated"] as const;
const GROUP_BY = ["assignee", "status", "sprint", "priority"] as const;

const def = <C extends z.ZodTypeAny>(d: PanelTypeDef<C>) => d;

export const PANEL_TYPES = {
  // ── Lists ───────────────────────────────────────────────────────────────
  "item-list": def({
    type: "item-list", label: "Item list", category: "list", needsQuery: true, supportsDrill: false,
    description: "Items matching the query, with the columns you choose, optionally grouped.",
    config: z.strictObject({
      columns: z.array(z.enum(ITEM_COLUMNS)).min(1).max(ITEM_COLUMNS.length).default(["key", "title", "status", "assignee", "priority", "due"]),
      groupBy: z.enum(GROUP_BY).nullable().default(null),
      limit: limit(25),
    }),
    size: { w: 6, h: 6, minW: 3, minH: 3 },
  }),
  "standup-walk": def({
    type: "standup-walk", label: "Standup walk", category: "list", needsQuery: true, supportsDrill: false,
    description: "Per person: done since the last standup, in progress, and blocked or at risk.",
    config: z.strictObject({ limit: limit(20) }),
    size: { w: 12, h: 7, minW: 6, minH: 4 },
  }),
  "changes-since": def({
    type: "changes-since", label: "Changes since", category: "list", needsQuery: true, supportsDrill: false,
    description: "Status, assignee and priority changes since the last standup or a window.",
    config: z.strictObject({
      fields: z.array(z.enum(["status", "assignee", "priority"])).min(1).default(["status", "assignee", "priority"]),
      since: z.union([z.literal("sinceLastStandup"), rel]).default("sinceLastStandup"),
      limit: limit(50),
    }),
    size: { w: 6, h: 6, minW: 3, minH: 3 },
  }),
  blockers: def({
    type: "blockers", label: "Blocked work", category: "list", needsQuery: true, supportsDrill: false,
    description: "Blocked items, what blocks them, and for how long.",
    config: z.strictObject({ limit: limit(25) }),
    size: { w: 6, h: 5, minW: 3, minH: 3 },
  }),
  "aging-wip": def({
    type: "aging-wip", label: "Aging work in progress", category: "list", needsQuery: true, supportsDrill: false,
    description: "In-progress items by working days in their current status.",
    config: z.strictObject({
      warnDays: z.number().int().min(1).max(90).default(3),
      dangerDays: z.number().int().min(1).max(180).default(7),
      limit: limit(25),
    }).refine((c) => c.dangerDays > c.warnDays, "Danger must be later than warning."),
    size: { w: 6, h: 5, minW: 3, minH: 3 },
  }),
  "due-soon": def({
    type: "due-soon", label: "Due soon", category: "list", needsQuery: true, supportsDrill: false,
    description: "Overdue, and due within a number of working days.",
    config: z.strictObject({ days: z.number().int().min(1).max(30).default(3), limit: limit(25) }),
    size: { w: 6, h: 5, minW: 3, minH: 3 },
  }),
  "my-work": def({
    type: "my-work", label: "My work", category: "list", needsQuery: true, supportsDrill: false,
    description: "What's assigned to, or watched by, whoever is looking.",
    config: z.strictObject({ mode: z.enum(["assigned", "watching"]).default("assigned"), limit: limit(25) }),
    size: { w: 6, h: 5, minW: 3, minH: 3 },
  }),

  // ── Numbers ─────────────────────────────────────────────────────────────
  number: def({
    type: "number", label: "Number", category: "number", needsQuery: true, supportsDrill: true,
    description: "One count or sum, coloured by thresholds, optionally against an earlier window.",
    config: z.strictObject({
      measure,
      thresholds: z.array(z.strictObject({ op: z.enum([">", ">=", "<", "<=", "="]), value: z.number(), tone })).max(5).default([]),
      compare: z.enum(["7d", "30d"]).nullable().default(null),
    }),
    size: { w: 3, h: 2, minW: 2, minH: 2 },
  }),
  "kpi-row": def({
    type: "kpi-row", label: "KPI row", category: "number", needsQuery: true, supportsDrill: true,
    description: "Two to six numbers in one tile, each its own query within the panel's.",
    config: z.strictObject({
      items: z.array(z.strictObject({ label: z.string().min(1).max(40), cql: z.string().max(1000).default(""), measure })).min(2).max(6),
    }),
    size: { w: 12, h: 2, minW: 4, minH: 2 },
  }),
  progress: def({
    type: "progress", label: "Progress", category: "number", needsQuery: true, supportsDrill: true,
    description: "Share done, by count or points, split by status category.",
    config: z.strictObject({ unit: z.enum(["count", "points"]).default("count") }),
    size: { w: 4, h: 2, minW: 3, minH: 2 },
  }),

  // ── Charts ──────────────────────────────────────────────────────────────
  breakdown: def({
    type: "breakdown", label: "Breakdown", category: "chart", needsQuery: true, supportsDrill: true,
    description: "Pie, donut or bars by one field.",
    config: z.strictObject({
      field: fieldRef.default({ kind: "sys", id: "status" }),
      chart: z.enum(["pie", "donut", "bar"]).default("donut"),
      measure,
      limit: z.number().int().min(2).max(25).default(10),
    }),
    size: { w: 4, h: 4, minW: 3, minH: 3 },
  }),
  stacked: def({
    type: "stacked", label: "Stacked bars", category: "chart", needsQuery: true, supportsDrill: true,
    description: "Bars by one field, stacked by another.",
    config: z.strictObject({
      x: fieldRef.default({ kind: "sys", id: "assignee" }),
      y: fieldRef.default({ kind: "sys", id: "statusCategory" }),
      bucket: z.enum(["day", "week", "month"]).nullable().default(null),
      measure,
      orientation: z.enum(["vertical", "horizontal"]).default("vertical"),
    }),
    size: { w: 6, h: 5, minW: 4, minH: 3 },
  }),
  matrix: def({
    type: "matrix", label: "Two-dimensional table", category: "chart", needsQuery: true, supportsDrill: true,
    description: "Counts for every pair of two fields, with totals.",
    config: z.strictObject({ x: fieldRef.default({ kind: "sys", id: "status" }), y: fieldRef.default({ kind: "sys", id: "assignee" }), measure }),
    size: { w: 6, h: 5, minW: 4, minH: 3 },
  }),
  "created-vs-resolved": def({
    type: "created-vs-resolved", label: "Created vs resolved", category: "chart", needsQuery: true, supportsDrill: true,
    description: "Items created and completed per day, week or month.",
    config: z.strictObject({ bucket: z.enum(["day", "week", "month"]).default("day"), window: rel.default("-30d"), cumulative: z.boolean().default(false) }),
    size: { w: 6, h: 4, minW: 4, minH: 3 },
  }),
  workload: def({
    type: "workload", label: "Workload", category: "chart", needsQuery: true, supportsDrill: true,
    description: "Open work per person, by count or points.",
    config: z.strictObject({ unit: z.enum(["count", "points"]).default("points") }),
    size: { w: 6, h: 4, minW: 4, minH: 3 },
  }),

  // ── Sprint and flow ─────────────────────────────────────────────────────
  burndown: def({
    type: "burndown", label: "Burndown / burnup", category: "flow", needsQuery: true, supportsDrill: false, needsSprint: true,
    description: "The sprint's remaining (or completed) work per working day, against ideal.",
    config: z.strictObject({ unit: z.enum(["count", "points"]).default("points"), mode: z.enum(["burndown", "burnup"]).default("burndown") }),
    size: { w: 6, h: 5, minW: 4, minH: 3 },
  }),
  "sprint-status": def({
    type: "sprint-status", label: "Sprint status", category: "flow", needsQuery: true, supportsDrill: false, needsSprint: true,
    description: "Days remaining, committed vs done, and scope added.",
    config: z.strictObject({}),
    size: { w: 4, h: 3, minW: 3, minH: 2 },
  }),
  cfd: def({
    type: "cfd", label: "Cumulative flow", category: "flow", needsQuery: true, supportsDrill: false,
    description: "Items per status category per day, from recorded status changes.",
    config: z.strictObject({ window: rel.default("-30d") }),
    size: { w: 6, h: 5, minW: 4, minH: 3 },
  }),
  throughput: def({
    type: "throughput", label: "Throughput", category: "flow", needsQuery: true, supportsDrill: false,
    description: "Items and points completed per sprint.",
    config: z.strictObject({ sprints: z.number().int().min(2).max(20).default(6) }),
    size: { w: 6, h: 4, minW: 4, minH: 3 },
  }),
  "cycle-time": def({
    type: "cycle-time", label: "Cycle time", category: "flow", needsQuery: true, supportsDrill: false,
    description: "Start to finish, in days, for completed items.",
    config: z.strictObject({ window: rel.default("-90d") }),
    size: { w: 6, h: 4, minW: 4, minH: 3 },
  }),
  "work-type-mix": def({
    type: "work-type-mix", label: "Work type mix", category: "flow", needsQuery: true, supportsDrill: false,
    description: "Completed work by type and by business vs enabler.",
    config: z.strictObject({ window: rel.default("-90d") }),
    size: { w: 4, h: 4, minW: 3, minH: 3 },
  }),

  // ── Context ─────────────────────────────────────────────────────────────
  markdown: def({
    type: "markdown", label: "Text", category: "context", needsQuery: false, supportsDrill: false,
    description: "Agenda, notes or links.",
    config: z.strictObject({ content: z.string().max(10_000).default("") }),
    size: { w: 4, h: 3, minW: 2, minH: 2 },
  }),
  activity: def({
    type: "activity", label: "Activity", category: "context", needsQuery: true, supportsDrill: false,
    description: "Recent changes to the items the query matches.",
    config: z.strictObject({ limit: limit(30) }),
    size: { w: 4, h: 6, minW: 3, minH: 3 },
  }),
} as const;

export type PanelType = keyof typeof PANEL_TYPES;
export const PANEL_TYPE_KEYS = Object.keys(PANEL_TYPES) as PanelType[];

export function isPanelType(t: string): t is PanelType {
  return Object.prototype.hasOwnProperty.call(PANEL_TYPES, t);
}

export type PanelConfig<T extends PanelType> = z.output<(typeof PANEL_TYPES)[T]["config"]>;

/** A panel's config, defaults applied, or why it isn't valid for its type. */
export function parsePanelConfig(type: string, config: unknown): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPanelType(type)) return { ok: false, error: `Unknown panel type "${type}".` };
  const r = (PANEL_TYPES[type].config as z.ZodTypeAny).safeParse(config ?? {});
  return r.success ? { ok: true, config: r.data as Record<string, unknown> } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ") };
}
