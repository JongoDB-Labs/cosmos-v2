/**
 * Drill-down (dashboards design §5.2): a clicked slice, bar, cell or number
 * becomes the CQL for the items behind it, the panel's query ANDed with one
 * clause per dimension. The same query feeds the drill dialog's rows and its
 * "Open in Issues" link, so what the chart counted and what the list shows
 * can't drift apart.
 *
 * Pure and client-safe.
 */
import { z } from "zod";
import { CQL_VERSION, type CqlNode, type CqlQuery, type CqlValue, type FieldRef, type RefEntity } from "@/lib/query/ast";
import { OTHER_ID, bucketEnd, TIME_FIELDS } from "@/lib/query/aggregate";
import { parseCql } from "@/lib/query/parser";
import type { PanelType } from "./panel-registry";

export const sliceSchema = z.strictObject({
  /** One key id per dimension, as the aggregate returned it; null is the empty group. */
  keys: z.array(z.union([z.string().max(200), z.null()])).max(2).default([]),
  /** For an "Other" key: the ids shown beside it, which Other excludes. */
  exclude: z.array(z.array(z.string().max(200)).max(50)).max(2).optional(),
  /** kpi-row: which number. created-vs-resolved: which series. */
  index: z.number().int().min(0).max(5).optional(),
  series: z.enum(["created", "resolved"]).optional(),
});
export type Slice = z.infer<typeof sliceSchema>;

const REF_ENTITY: Partial<Record<string, RefEntity>> = {
  project: "project", type: "type", sprint: "interval", team: "team", label: "label",
  assignee: "user", primaryAssignee: "user", reporter: "user",
};
/** Fields whose empty group exists and can be asked for. */
const EMPTYABLE = new Set(["assignee", "primaryAssignee", "label", "sprint", "team", "highlight", "due", "start", "completed", "status"]);

interface Dim {
  field: FieldRef;
  bucket?: "day" | "week" | "month";
}

function valueOf(field: FieldRef, id: string): CqlValue {
  if (field.kind === "sys") {
    const entity = REF_ENTITY[field.id];
    if (entity) return { t: "ref", entity, id };
  }
  return { t: "str", v: id };
}

/** The clause one key of one dimension stands for, or null when it adds nothing. */
export function sliceClause(dim: Dim, key: string | null, exclude: string[] | undefined, tz: string): CqlNode | null {
  const f = dim.field;
  const time = f.kind === "sys" ? (TIME_FIELDS as readonly string[]).includes(f.id) : !!dim.bucket;
  if (key === null) {
    return EMPTYABLE.has(f.kind === "sys" ? f.id : "") || f.kind === "cf" ? { op: "empty", field: f } : null;
  }
  if (key === OTHER_ID) {
    const shown = (exclude ?? []).filter((x) => x !== OTHER_ID);
    return { op: "in", field: f, negate: true, values: shown.map((x) => valueOf(f, x)) };
  }
  if (time && dim.bucket) {
    return {
      op: "and",
      args: [
        { op: "cmp", field: f, cmp: "gte", value: { t: "date", v: key } },
        { op: "cmp", field: f, cmp: "lt", value: { t: "date", v: bucketEnd(key, dim.bucket, tz) } },
      ],
    };
  }
  return { op: "cmp", field: f, cmp: "eq", value: valueOf(f, key) };
}

const and = (q: CqlQuery, ...nodes: (CqlNode | null)[]): CqlQuery => {
  const parts = [q.where, ...nodes].filter((n): n is CqlNode => !!n);
  return { ...q, v: CQL_VERSION, where: parts.length === 0 ? null : parts.length === 1 ? parts[0] : { op: "and", args: parts } };
};
const text = (cql: string) => parseCql(cql).query.where;

/** The dimensions a chart panel grouped by, for its config. */
function dimsOf(type: PanelType, config: Record<string, unknown>): Dim[] | null {
  const f = (x: unknown) => x as FieldRef;
  switch (type) {
    case "breakdown":
      return [{ field: f(config.field) }];
    case "stacked":
      return [{ field: f(config.x), ...(config.bucket ? { bucket: config.bucket as Dim["bucket"] } : {}) }, { field: f(config.y) }];
    case "matrix":
      return [{ field: f(config.x) }, { field: f(config.y) }];
    case "workload":
      return [{ field: { kind: "sys", id: "assignee" } }];
    case "progress":
      return [{ field: { kind: "sys", id: "statusCategory" } }];
    case "number":
      return [];
    default:
      return null;
  }
}

/**
 * The query for a slice of a panel, or null when the panel can't drill.
 * `query` is the panel's query with the dashboard's filters already applied.
 */
export function drillQuery(type: PanelType, config: Record<string, unknown>, query: CqlQuery, slice: Slice, tz: string): CqlQuery | null {
  if (type === "kpi-row") {
    const items = config.items as { cql: string }[];
    const it = items[slice.index ?? 0];
    return it ? and(query, it.cql.trim() ? text(it.cql) : null) : null;
  }
  if (type === "created-vs-resolved") {
    const field: FieldRef = { kind: "sys", id: slice.series === "resolved" ? "completed" : "created" };
    const key = slice.keys[0];
    return key ? and(query, sliceClause({ field, bucket: config.bucket as Dim["bucket"] }, key, undefined, tz)) : null;
  }
  const dims = dimsOf(type, config);
  if (!dims) return null;
  // Workload counts open work only; its drill must too.
  const base = type === "workload" ? and(query, text("statusCategory NOT IN (DONE, CANCELLED)")) : query;
  return and(base, ...dims.map((d, i) => (i < slice.keys.length ? sliceClause(d, slice.keys[i], slice.exclude?.[i], tz) : null)));
}
