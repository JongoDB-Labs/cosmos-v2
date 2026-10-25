/**
 * The dashboard filter bar (dashboards design §5.3): controls such as Person,
 * Sprint or Project whose values narrow every panel at once.
 *
 * A filter is NOT a second filter format (ops reconciliation 1–3). Each one
 * compiles to an ordinary CQL clause, ANDed into a panel's own query unless
 * the panel lists the key in `ignoreFilters`. The same values are also handed
 * to the query as variables, so a panel written as `assignee = $person`
 * follows the bar too. An unset filter adds nothing (the panel shows everyone),
 * the same rule as an unset variable.
 *
 * Pure and client-safe: the editor previews what a filter does with it.
 */
import { z } from "zod";
import type { CqlNode, CqlQuery, CqlValue, FieldRef } from "@/lib/query/ast";
import { CQL_VERSION } from "@/lib/query/ast";

/** The built-in filter keys; `cf.<key>` filters a custom field. */
export const FILTER_KEYS = ["project", "team", "sprint", "person", "labels", "type", "priority", "dateWindow"] as const;
export type BuiltinFilterKey = (typeof FILTER_KEYS)[number];
export type FilterKey = BuiltinFilterKey | `cf.${string}`;

/** What a value means for each key. `dateWindow` is a relative date such as `-7d`. */
const FIELD_OF: Record<Exclude<BuiltinFilterKey, "dateWindow">, FieldRef> = {
  project: { kind: "sys", id: "project" },
  team: { kind: "sys", id: "team" },
  sprint: { kind: "sys", id: "sprint" },
  person: { kind: "sys", id: "assignee" },
  labels: { kind: "sys", id: "label" },
  type: { kind: "sys", id: "type" },
  priority: { kind: "sys", id: "priority" },
};

/**
 * Value tokens a default may use so it means the same thing for every viewer:
 * `@me` is the viewer, `@currentSprint` the active sprint(s).
 */
export const VALUE_TOKENS = { "@me": "currentUser", "@currentSprint": "currentSprint" } as const;

const keySchema = z.union([z.enum(FILTER_KEYS), z.string().regex(/^cf\.[A-Za-z_][A-Za-z0-9_]{0,63}$/)]);
const scalar = z.union([z.string().max(200), z.number()]);
export const filterValueSchema = z.union([scalar, z.array(scalar).max(200), z.null()]);
export type FilterValue = z.infer<typeof filterValueSchema>;

export const filterDefSchema = z.strictObject({
  key: keySchema,
  label: z.string().max(60).optional(),
  multi: z.boolean().default(true),
  default: filterValueSchema.default(null),
});
export type DashboardFilterDef = z.infer<typeof filterDefSchema>;

export const filterDefsSchema = z.array(filterDefSchema).max(8).refine((defs) => new Set(defs.map((d) => d.key)).size === defs.length, "Each filter key can appear once.");

export type FilterValues = Record<string, FilterValue | undefined>;

/** A relative window such as `-7d`, `-2w`, `-1M` or `-5wd` (working days). */
const WINDOW = /^-\d{1,4}(d|w|M|wd)$/;

/**
 * The value in force for each filter: the URL's, else the viewer's
 * remembered one, else the filter's default (design §5.3 precedence).
 * `undefined` at a level means "not set there"; `null` means "everyone".
 */
export function effectiveValues(defs: readonly DashboardFilterDef[], ...layers: (FilterValues | undefined)[]): FilterValues {
  const out: FilterValues = {};
  for (const d of defs) {
    let v: FilterValue | undefined;
    for (const layer of layers) {
      if (layer && layer[d.key] !== undefined) {
        v = layer[d.key];
        break;
      }
    }
    out[d.key] = v === undefined ? d.default : v;
  }
  return out;
}

function valueNode(v: string | number): CqlValue {
  if (typeof v === "number") return { t: "num", v };
  const fn = VALUE_TOKENS[v as keyof typeof VALUE_TOKENS];
  return fn ? { t: "fn", name: fn, args: [] } : { t: "str", v };
}

/** The clause one filter adds for one value, or null when it adds nothing. */
export function filterClause(key: string, value: FilterValue | undefined): CqlNode | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  if (key === "dateWindow") {
    const w = list[0];
    if (typeof w !== "string" || !WINDOW.test(w)) return null;
    return { op: "cmp", field: { kind: "sys", id: "updated" }, cmp: "gte", value: { t: "rel", v: w } } as CqlNode;
  }
  const field: FieldRef | undefined = key.startsWith("cf.") ? { kind: "cf", key: key.slice(3) } : FIELD_OF[key as keyof typeof FIELD_OF];
  if (!field) return null;
  // An empty selection is "nobody": it matches nothing, it does not widen.
  return { op: "in", field, values: list.map(valueNode) } as CqlNode;
}

/** The panel's own where, ANDed with every filter it doesn't ignore. */
export function withFilters(
  query: CqlQuery | null,
  defs: readonly DashboardFilterDef[],
  values: FilterValues,
  ignore: readonly string[] = [],
): CqlQuery {
  const clauses: CqlNode[] = [];
  if (query?.where) clauses.push(query.where);
  for (const d of defs) {
    if (ignore.includes(d.key)) continue;
    const c = filterClause(d.key, values[d.key]);
    if (c) clauses.push(c);
  }
  const where = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0] : ({ op: "and", args: clauses } as CqlNode);
  return { v: CQL_VERSION, where, ...(query?.orderBy ? { orderBy: query.orderBy } : {}), ...(query?.context ? { context: query.context } : {}) };
}

/** The same values as CQL variables (`$person`, `$sprint`…), for panels that name them. */
export function filterVars(values: FilterValues): Record<string, string | number | (string | number)[] | null> {
  const out: Record<string, string | number | (string | number)[] | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || k === "dateWindow") continue;
    const name = k.startsWith("cf.") ? `cf_${k.slice(3)}` : k;
    // Tokens can't travel as variable values; those filters reach panels as clauses only.
    const strip = (x: string | number) => (typeof x === "string" && x in VALUE_TOKENS ? null : x);
    if (Array.isArray(v)) {
      const kept = v.map(strip).filter((x): x is string | number => x !== null);
      out[name] = kept.length === v.length ? kept : null;
    } else out[name] = v === null ? null : strip(v);
  }
  return out;
}
