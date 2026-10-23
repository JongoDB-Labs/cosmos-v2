/**
 * `aggregateCql`: group and measure what a CQL query matches, for dashboards
 * (aggregate.ts has the pure part). The items come from the same pipeline as
 * search, `prepareCql` + `buildScopedWhere`, so a chart never counts an item
 * its viewer couldn't list, and two viewers of one dashboard can see different
 * numbers. Every group label is looked up from those items' own ids.
 */
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { buildScopedWhere } from "@/lib/work-items/query/build-where";
import type { FieldRef } from "./ast";
import { CqlError, diag } from "./errors";
import { prepareCql, withStatementTimeout, type CqlInput, type CqlRunOptions } from "./execute.server";
import type { StatusCategory } from "./env";
import type { CustomFieldType } from "./typecheck";
import {
  OTHER_ID,
  aggProblem,
  bucketOf,
  fold,
  isTimeDim,
  type AggDim,
  type AggFact,
  type AggKey,
  type AggMeasure,
  type AggRow,
} from "./aggregate";

/** Items an aggregate reads; past this it is refused rather than half-counted. */
export const AGG_MAX_ITEMS = 200_000;
const CHUNK = 10_000;

export interface AggResult {
  rows: AggRow[];
  /** Items the query matched. */
  total: number;
  /** Some groups folded into "Other". */
  truncated: boolean;
  query: unknown;
  cql: string;
}

const SELECT = {
  id: true,
  projectId: true,
  columnKey: true,
  completedAt: true,
  priority: true,
  assigneeId: true,
  createdById: true,
  intervalId: true,
  teamId: true,
  workItemTypeId: true,
  workCategory: true,
  highlight: true,
  storyPoints: true,
  originalEstimate: true,
  remainingEstimate: true,
  timeSpent: true,
  createdAt: true,
  updatedAt: true,
  dueDate: true,
  startDate: true,
  customFields: true,
  assignees: { select: { userId: true } },
  labels: { select: { labelId: true } },
} satisfies Prisma.WorkItemSelect;
type Item = Prisma.WorkItemGetPayload<{ select: typeof SELECT }>;

const TIME_COLUMN = { created: "createdAt", updated: "updatedAt", completed: "completedAt", due: "dueDate", start: "startDate" } as const;
const MEASURE_COLUMN = { points: "storyPoints", originalEstimate: "originalEstimate", remainingEstimate: "remainingEstimate", timeSpent: "timeSpent" } as const;

const isEmptyJson = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export async function aggregateCql(
  ctx: AuthContext,
  input: CqlInput,
  req: { dims: AggDim[]; measure: AggMeasure },
  opts: CqlRunOptions = {},
): Promise<AggResult> {
  const prepared = await prepareCql(ctx, input, opts);
  const tz = opts.tz ?? "UTC";
  const cfTypes = prepared.env.customFields;
  const problem = aggProblem(req.dims, req.measure, cfTypes);
  if (problem) throw new CqlError([diag("", "CQL_TYPE_MISMATCH", problem)]);
  if (prepared.readable.length === 0) return { rows: [], total: 0, truncated: false, query: prepared.query, cql: prepared.cql };

  const where = buildScopedWhere({
    orgId: prepared.orgId,
    allowedProjectIds: prepared.readable,
    archived: prepared.compiled.archived,
    user: prepared.compiled.where,
  });

  return withStatementTimeout(opts.timeoutMs ?? 5_000, async (tx) => {
    // Every matching item, in id order, a chunk at a time.
    const items: Item[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await tx.workItem.findMany({
        where,
        select: SELECT,
        orderBy: { id: "asc" },
        take: CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      items.push(...page);
      if (items.length > AGG_MAX_ITEMS) {
        throw new CqlError([
          diag("", "CQL_TOO_BROAD", `Charts count at most ${AGG_MAX_ITEMS.toLocaleString("en-US")} items. Narrow the query with a project or a date range.`),
        ], 422);
      }
      if (page.length < CHUNK) break;
      cursor = page[page.length - 1].id;
    }

    const columns = await statusColumns(tx, prepared.readable);
    const dimKeys = req.dims.map((d) => keysOf(d, cfTypes, columns, tz));
    const value = measureOf(req.measure);
    const facts: AggFact[] = items.map((it) => ({ keys: dimKeys.map((k) => k(it)), value: value(it) }));

    let folded: ReturnType<typeof fold>;
    try {
      folded = fold(
        facts,
        req.dims.map((d) => ({ time: isTimeDim(d, cfTypes), bucket: d.bucket, limit: d.limit ?? 25 })),
        req.measure.fn,
        tz,
      );
    } catch (e) {
      if (e instanceof RangeError) {
        throw new CqlError([diag("", "CQL_TOO_BROAD", "That's too many time buckets for one chart. Use a coarser bucket (week or month) or a shorter range.")], 422);
      }
      throw e;
    }

    const labels = await labelsFor(tx, req.dims, folded.rows.map((r) => r.keys), cfTypes, tz);
    return {
      rows: folded.rows.map((r) => ({
        keys: r.keys.map((k, i): AggKey => ({ id: k, label: labels[i](k) })),
        value: r.value,
        count: r.count,
      })),
      total: items.length,
      truncated: folded.folded,
      query: prepared.query,
      cql: prepared.cql,
    };
  });
}

type Columns = Map<string, { name: string; category: StatusCategory }>;

/** Each readable project's column key → name and category; the first column (by board order) wins, as everywhere. */
async function statusColumns(tx: Prisma.TransactionClient, readable: string[]): Promise<Columns> {
  const rows = await tx.boardColumn.findMany({
    where: { board: { projectId: { in: readable } } },
    select: { key: true, name: true, category: true, board: { select: { projectId: true } } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const out: Columns = new Map();
  for (const r of rows) {
    const k = `${r.board.projectId}:${r.key}`;
    if (!out.has(k)) out.set(k, { name: r.name, category: r.category as StatusCategory });
  }
  return out;
}

/** An item's status category, one per item: cancelled lanes, then finished, then its lane's category. */
function categoryOf(it: Item, columns: Columns): StatusCategory {
  const c = columns.get(`${it.projectId}:${it.columnKey}`);
  if (c?.category === "CANCELLED") return "CANCELLED";
  if (it.completedAt) return "DONE";
  // The seeded "done" lane counts as done where no board describes it (done-state.ts).
  return c?.category ?? (it.columnKey === "done" ? "DONE" : "TODO");
}

/** A dimension's key ids for one item: none (the empty group), one, or several (multi-valued fields). */
function keysOf(d: AggDim, cfTypes: ReadonlyMap<string, CustomFieldType>, columns: Columns, tz: string): (it: Item) => string[] {
  const one = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? [] : [v]);
  const day = (v: Date | string | null | undefined) => (v ? [bucketOf(new Date(v), d.bucket!, tz)] : []);
  const f = d.field;
  if (f.kind === "cf") {
    const type = cfTypes.get(f.key);
    return (it) => {
      const v = (it.customFields as Record<string, unknown> | null)?.[f.key];
      if (isEmptyJson(v)) return [];
      if (type === "DATE") return typeof v === "string" ? day(`${v.slice(0, 10)}T00:00:00Z`) : [];
      if (Array.isArray(v)) return [...new Set(v.map(String))];
      return [String(v)];
    };
  }
  switch (f.id) {
    case "project":
      return (it) => [it.projectId];
    case "type":
      return (it) => [it.workItemTypeId];
    case "status":
      // By name, so one "Done" across projects is one group.
      return (it) => one(columns.get(`${it.projectId}:${it.columnKey}`)?.name ?? it.columnKey);
    case "statusCategory":
      return (it) => [categoryOf(it, columns)];
    case "priority":
      return (it) => [it.priority];
    case "assignee":
      // The primary or any co-assignee, as `assignee =` matches.
      return (it) => [...new Set([...one(it.assigneeId), ...it.assignees.map((a) => a.userId)])];
    case "primaryAssignee":
      return (it) => one(it.assigneeId);
    case "reporter":
      return (it) => one(it.createdById);
    case "label":
      return (it) => [...new Set(it.labels.map((l) => l.labelId))];
    case "sprint":
      return (it) => one(it.intervalId);
    case "team":
      return (it) => one(it.teamId);
    case "workCategory":
      return (it) => one(it.workCategory);
    case "highlight":
      return (it) => one(it.highlight);
    default: {
      const col = TIME_COLUMN[f.id as keyof typeof TIME_COLUMN];
      if (col) return (it) => day(it[col]);
      throw new Error(`no dimension for ${f.id}`);
    }
  }
}

function measureOf(m: AggMeasure): (it: Item) => number | null {
  if (m.fn === "count") return () => null;
  const f = m.field;
  if (f.kind === "cf") {
    return (it) => {
      const v = (it.customFields as Record<string, unknown> | null)?.[f.key];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
  }
  const col = MEASURE_COLUMN[f.id as keyof typeof MEASURE_COLUMN];
  return (it) => it[col] ?? null;
}

const ENUM_LABEL = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ");
const CATEGORY_LABEL: Record<StatusCategory, string> = { TODO: "To do", IN_PROGRESS: "In progress", DONE: "Done", CANCELLED: "Cancelled" };

/** Per dimension, id → display label, from the ids the rows actually use. */
async function labelsFor(
  tx: Prisma.TransactionClient,
  dims: AggDim[],
  keys: (string | null)[][],
  cfTypes: ReadonlyMap<string, CustomFieldType>,
  tz: string,
): Promise<((id: string | null) => string)[]> {
  return Promise.all(
    dims.map(async (d, i) => {
      const ids = [...new Set(keys.map((k) => k[i]).filter((k): k is string => k !== null && k !== OTHER_ID))];
      const time = isTimeDim(d, cfTypes);
      const named = time ? bucketLabels(ids, d.bucket!, tz) : await namesFor(tx, d.field, ids, cfTypes);
      const none = emptyLabel(d.field, time);
      return (id: string | null) => (id === null ? none : id === OTHER_ID ? "Other" : (named.get(id) ?? id));
    }),
  );
}

/** "2026-10-19" for a day or a week (its Monday), "2026-10" for a month, in the request's time zone. */
function bucketLabels(ids: string[], bucket: "day" | "week" | "month", tz: string): Map<string, string> {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return new Map(ids.map((id) => {
    const d = ymd.format(new Date(id));
    return [id, bucket === "month" ? d.slice(0, 7) : d];
  }));
}

function emptyLabel(f: FieldRef, time: boolean): string {
  if (time) return "No date";
  if (f.kind === "cf") return "None";
  const word: Partial<Record<string, string>> = {
    assignee: "Unassigned",
    primaryAssignee: "Unassigned",
    sprint: "No sprint",
    team: "No team",
    label: "No labels",
    workCategory: "None",
    highlight: "None",
  };
  return word[f.id] ?? "None";
}

async function namesFor(
  tx: Prisma.TransactionClient,
  f: FieldRef,
  ids: string[],
  cfTypes: ReadonlyMap<string, CustomFieldType>,
): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (ids.length === 0) return m;
  const users = async () => {
    for (const u of await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })) m.set(u.id, u.displayName);
  };
  if (f.kind === "cf") {
    if (cfTypes.get(f.key) === "USER") await users();
    return m;
  }
  switch (f.id) {
    case "project":
      for (const p of await tx.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) m.set(p.id, p.name);
      break;
    case "type":
      for (const t of await tx.workItemType.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) m.set(t.id, t.name);
      break;
    case "sprint":
      for (const s of await tx.interval.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) m.set(s.id, s.name);
      break;
    case "team":
      for (const t of await tx.team.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) m.set(t.id, t.name);
      break;
    case "label":
      for (const l of await tx.label.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) m.set(l.id, l.name);
      break;
    case "assignee":
    case "primaryAssignee":
    case "reporter":
      await users();
      break;
    case "statusCategory":
      for (const id of ids) m.set(id, CATEGORY_LABEL[id as StatusCategory] ?? id);
      break;
    case "priority":
    case "workCategory":
    case "highlight":
      for (const id of ids) m.set(id, ENUM_LABEL(id));
      break;
    default:
      // Status names and time buckets are their own labels.
      for (const id of ids) m.set(id, id);
  }
  return m;
}
