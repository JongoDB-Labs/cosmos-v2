/**
 * Aggregation over a CQL query (query design §5, dashboards design §4.4, ops
 * reconciliation item 4): group the items a query matches by up to two
 * dimensions and measure each group. PURE: the request shape and the folding
 * of item values into groups. aggregate.server.ts loads the items (through the
 * same scoped pipeline as search) and the labels.
 */
import { z } from "zod";
import type { FieldRef } from "./ast";
import { fieldDef, type SystemFieldId } from "./fields";
import { startOf } from "./dates";
import type { CustomFieldType } from "./typecheck";

/** Groups per dimension before the rest fold into "Other". */
export const AGG_MAX_GROUPS = 25;
/** Time buckets per series. */
export const AGG_MAX_BUCKETS = 366;

/** Date fields a time dimension can bucket. */
export const TIME_FIELDS = ["created", "updated", "completed", "due", "start"] as const satisfies readonly SystemFieldId[];
/** Number fields a measure can sum. */
export const MEASURE_FIELDS = ["points", "originalEstimate", "remainingEstimate", "timeSpent"] as const satisfies readonly SystemFieldId[];
/** Custom field types a dimension can group by (DATE buckets like a time field). */
export const GROUPABLE_CF = new Set<CustomFieldType>(["SELECT", "MULTI_SELECT", "CHECKBOX", "USER", "DATE"]);

/** A field to group or measure by, as the aggregate endpoint and dashboard panels take it. */
export const aggFieldSchema = z.union([
  z.strictObject({ kind: z.literal("sys"), id: z.string().max(40) }),
  z.strictObject({ kind: z.literal("cf"), key: z.string().regex(/^[A-Za-z0-9_]{1,100}$/) }),
]);

export const aggDimSchema = z.strictObject({
  field: aggFieldSchema,
  /** Time fields only: the bucket, in the request's time zone. */
  bucket: z.enum(["day", "week", "month"]).optional(),
  /** Groups to keep before the rest fold into "Other" (time series keep every bucket). */
  limit: z.number().int().min(1).max(AGG_MAX_GROUPS).optional(),
});
export type AggDim = { field: FieldRef; bucket?: "day" | "week" | "month"; limit?: number };

export const aggMeasureSchema = z.union([
  z.strictObject({ fn: z.literal("count") }),
  z.strictObject({ fn: z.enum(["sum", "avg", "min", "max"]), field: aggFieldSchema }),
]);
export type AggMeasure = { fn: "count" } | { fn: "sum" | "avg" | "min" | "max"; field: FieldRef };

/** One group key. `id` null is the empty group ("No assignee"); "__other__" is the folded rest. */
export interface AggKey {
  id: string | null;
  label: string;
}
export const OTHER_ID = "__other__";

export interface AggRow {
  keys: AggKey[];
  /** The measure: a count, or the sum / average / minimum / maximum. */
  value: number;
  /** Items in the group (a multi-valued field counts an item once per value). */
  count: number;
}

/** Why a dimension or measure can't be used, or null. Uses the registry and the org's custom fields. */
export function aggProblem(
  dims: AggDim[],
  measure: AggMeasure,
  cfTypes: ReadonlyMap<string, CustomFieldType>,
): string | null {
  for (const d of dims) {
    const time = isTimeDim(d, cfTypes);
    if (d.field.kind === "sys") {
      const def = fieldDef(d.field.id as SystemFieldId);
      if (!def) return `Unknown field \`${d.field.id}\`.`;
      if (!time && !def.groupable) return `Can't group by \`${d.field.id}\`.`;
    } else {
      const t = cfTypes.get(d.field.key);
      if (!t) return `Unknown custom field \`${d.field.key}\`.`;
      if (!GROUPABLE_CF.has(t)) return `Can't group by a ${t.toLowerCase().replace("_", "-")} custom field.`;
    }
    if (time && !d.bucket) return "A date dimension needs a bucket: day, week or month.";
    if (!time && d.bucket) return "Only date fields take a bucket.";
  }
  if (dims.length > 2) return "At most two dimensions.";
  if (measure.fn !== "count") {
    const f = measure.field;
    if (f.kind === "sys" ? !(MEASURE_FIELDS as readonly string[]).includes(f.id) : cfTypes.get(f.key) !== "NUMBER") {
      return "Sum, average, minimum and maximum take points, an estimate, time spent or a number custom field.";
    }
  }
  return null;
}

export function isTimeDim(d: AggDim, cfTypes: ReadonlyMap<string, CustomFieldType>): boolean {
  return d.field.kind === "sys" ? (TIME_FIELDS as readonly string[]).includes(d.field.id) : cfTypes.get(d.field.key) === "DATE";
}

/** The start of the bucket an instant falls in, as an ISO string (the key id). */
export function bucketOf(at: Date, bucket: "day" | "week" | "month", tz: string): string {
  return startOf(bucket, at, tz).toISOString();
}

/** Every bucket from the first to the last, so a chart's empty periods read as zero. Null if there are too many. */
export function bucketRange(first: string, last: string, bucket: "day" | "week" | "month", tz: string): string[] | null {
  const out: string[] = [];
  const end = new Date(last).getTime();
  for (let at = new Date(first); at.getTime() <= end; at = startOf(bucket, at, tz, 1)) {
    out.push(at.toISOString());
    if (out.length > AGG_MAX_BUCKETS) return null;
  }
  return out;
}

/** What one item contributes: its key ids per dimension (a multi-valued field gives several) and its measure value. */
export interface AggFact {
  keys: (string | null)[][];
  /** The measure's input; null = no value (counted, but not in a sum / average / min / max). */
  value: number | null;
}

interface Acc {
  keys: (string | null)[];
  count: number;
  n: number;
  sum: number;
  min: number;
  max: number;
}

/**
 * Fold facts into rows. For each non-time dimension, the groups with the
 * largest measure are kept (`limit`, at most AGG_MAX_GROUPS) and the rest
 * fold into "Other"; time dimensions keep every bucket and are filled between
 * the first and last. Returns the rows (by time, else by value), and whether
 * anything was folded.
 */
export function fold(
  facts: AggFact[],
  dims: { time: boolean; bucket?: "day" | "week" | "month"; limit: number }[],
  fn: AggMeasure["fn"],
  tz: string,
): { rows: { keys: (string | null)[]; value: number; count: number }[]; folded: boolean } {
  const accs = new Map<string, Acc>();
  const add = (keys: (string | null)[], value: number | null) => {
    const k = JSON.stringify(keys);
    const a = accs.get(k) ?? { keys, count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
    a.count++;
    if (value !== null) {
      a.n++;
      a.sum += value;
      a.min = Math.min(a.min, value);
      a.max = Math.max(a.max, value);
    }
    accs.set(k, a);
  };
  for (const f of facts) {
    // The cross product of each dimension's values (one combination for single-valued fields).
    let combos: (string | null)[][] = [[]];
    for (const ks of f.keys) combos = combos.flatMap((c) => (ks.length ? ks : [null]).map((k) => [...c, k]));
    for (const c of [...new Set(combos.map((c) => JSON.stringify(c)))]) add(JSON.parse(c), f.value);
  }
  const valueOf = (a: Pick<Acc, "count" | "n" | "sum" | "min" | "max">) =>
    fn === "count" ? a.count : a.n === 0 ? 0 : fn === "sum" ? a.sum : fn === "avg" ? a.sum / a.n : fn === "min" ? a.min : a.max;

  // Which keys each non-time dimension keeps: the top `limit` by the dimension's own total.
  let folded = false;
  const keep = dims.map((d, i) => {
    if (d.time) return null;
    const totals = new Map<string | null, Acc>();
    for (const a of accs.values()) {
      const k = a.keys[i];
      const t = totals.get(k) ?? { keys: [], count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
      t.count += a.count;
      t.n += a.n;
      t.sum += a.sum;
      t.min = Math.min(t.min, a.min);
      t.max = Math.max(t.max, a.max);
      totals.set(k, t);
    }
    const ranked = [...totals.entries()].sort((x, y) => valueOf(y[1]) - valueOf(x[1]) || String(x[0]).localeCompare(String(y[0])));
    if (ranked.length > d.limit) folded = true;
    return new Set(ranked.slice(0, d.limit).map(([k]) => k));
  });

  // Re-key with Other, merging what folds together.
  const merged = new Map<string, Acc>();
  for (const a of accs.values()) {
    const keys = a.keys.map((k, i) => (keep[i] && !keep[i]!.has(k) ? OTHER_ID : k));
    const k = JSON.stringify(keys);
    const m = merged.get(k) ?? { keys, count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
    m.count += a.count;
    m.n += a.n;
    m.sum += a.sum;
    m.min = Math.min(m.min, a.min);
    m.max = Math.max(m.max, a.max);
    merged.set(k, m);
  }
  let rows = [...merged.values()].map((a) => ({ keys: a.keys, value: valueOf(a), count: a.count }));

  // A single time dimension: fill the empty buckets between the first and the last.
  const t = dims.findIndex((d) => d.time);
  if (t >= 0 && dims.length === 1) {
    const dated = rows.map((r) => r.keys[0]).filter((k): k is string => k !== null).sort();
    if (dated.length) {
      const all = bucketRange(dated[0], dated[dated.length - 1], dims[0].bucket!, tz);
      if (all === null) throw new RangeError("too many buckets");
      const have = new Set(dated);
      for (const b of all) if (!have.has(b)) rows.push({ keys: [b], value: 0, count: 0 });
    }
  }
  rows = rows.sort((x, y) => {
    // Time first (oldest first, no date last), else the biggest first, Other last.
    if (t >= 0) {
      const a = x.keys[t];
      const b = y.keys[t];
      if (a !== b) return a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
    }
    const otherX = x.keys.includes(OTHER_ID);
    const otherY = y.keys.includes(OTHER_ID);
    if (otherX !== otherY) return otherX ? 1 : -1;
    return y.value - x.value || JSON.stringify(x.keys).localeCompare(JSON.stringify(y.keys));
  });
  return { rows, folded };
}
