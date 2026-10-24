/**
 * CqlQuery v1: the ONE filter format for work items.
 *
 * Every surface that filters work items stores or sends this shape: the Issues
 * view (text CQL and the visual chips are two editors for it), boards, saved
 * filters, dashboard panels, subscriptions and the assistant. It is plain JSON,
 * versioned, validated by `cqlQuerySchema`, and never trusted: every query is
 * compiled inside the readable-project scope envelope (`buildScopedWhere`).
 *
 * Canonical stored form: values that name things are RESOLVED refs (ids) with a
 * display label as a hint only, and functions/variables stay symbolic so they
 * are re-evaluated on every run. Renaming a sprint or a person therefore never
 * breaks a saved query; the printer (`print.ts`) regenerates text from current
 * names.
 *
 * Pure and client-safe: no Prisma, no server imports.
 */
import { z } from "zod";
import { FUNCTION_NAMES, type FunctionName } from "./functions";
import { SYSTEM_FIELD_IDS, type SystemFieldId } from "./fields";

export const CQL_VERSION = 1 as const;

/** Hard limits. Text limits are checked by the parser, AST limits by `validateAst`. */
export const CQL_LIMITS = {
  /** Characters of query text (WIQL allows 32K; we have no SELECT list). */
  textLength: 4000,
  /** Parenthesis nesting in text (GitHub's cap). */
  parenDepth: 5,
  /** and/or/not nesting in a JSON AST, which may also come from a composer. */
  nodeDepth: 8,
  /** Clauses (leaf nodes) in one query. */
  clauses: 50,
  /** Values in one IN list. */
  inValues: 200,
  /** WAS / CHANGED clauses. */
  historyClauses: 3,
  /** ORDER BY keys. */
  sortKeys: 3,
} as const;

export type FieldRef =
  | { kind: "sys"; id: SystemFieldId }
  /** CustomField.key. */
  | { kind: "cf"; key: string };

/** Entities a resolved value can point at. */
export const REF_ENTITIES = [
  "user",
  "project",
  "type",
  "status",
  "interval",
  "team",
  "label",
  "item",
  "milestone",
] as const;
export type RefEntity = (typeof REF_ENTITIES)[number];

/**
 * A relative offset, JQL style: `-7d`, `+2w`, `3h`, `-1M` (months), `-30m`
 * (minutes), and `-3wd` (working days, weekends skipped). ISO-8601 durations
 * were the first idea, but they cannot say "working days".
 */
export const REL_RE = /^[+-]?\d{1,5}(wd|y|M|w|d|h|m)$/;

export type CqlValue =
  /** Unresolved literal, as typed. The resolver turns names into refs. */
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  /** ISO date `YYYY-MM-DD` or datetime. */
  | { t: "date"; v: string }
  | { t: "rel"; v: string }
  /** RESOLVED. `label` is a display hint only, never used to resolve. */
  | { t: "ref"; entity: RefEntity; id: string; label?: string }
  | { t: "fn"; name: FunctionName; args: CqlValue[] }
  /** Dashboard variable (`$speaker`), supplied by the caller at run time. */
  | { t: "var"; name: string }
  /** `EMPTY` inside an IN list, e.g. `assignee IN (me, EMPTY)`. */
  | { t: "empty" };

/** FROM / TO / BY: one value, or a list (`BY (me, "dana")`, or a status name that is a different key in each project). */
export type PredValue = CqlValue | CqlValue[];

/** A FROM / TO / BY value as a list. */
export function predValues(v: PredValue | undefined): CqlValue[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export type HistoryPreds = {
  from?: PredValue;
  to?: PredValue;
  by?: PredValue;
  after?: CqlValue;
  before?: CqlValue;
  on?: CqlValue;
  during?: [CqlValue, CqlValue];
};

export type CmpOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

export type CqlNode =
  | { op: "and"; args: CqlNode[] }
  | { op: "or"; args: CqlNode[] }
  | { op: "not"; arg: CqlNode }
  | { op: "cmp"; field: FieldRef; cmp: CmpOp; value: CqlValue }
  | { op: "in"; field: FieldRef; negate?: boolean; all?: boolean; values: CqlValue[] }
  | { op: "empty"; field: FieldRef; negate?: boolean }
  | { op: "text"; field: FieldRef; negate?: boolean; query: string }
  | { op: "was"; field: FieldRef; negate?: boolean; values: CqlValue[]; preds?: HistoryPreds }
  | { op: "changed"; field: FieldRef; preds?: HistoryPreds };

export type CqlSort = {
  field: FieldRef;
  dir: "asc" | "desc";
  nulls?: "first" | "last";
};

export type CqlQuery = {
  v: typeof CQL_VERSION;
  /** null = everything in scope. */
  where: CqlNode | null;
  orderBy?: CqlSort[];
  /** Where the query was authored; context macros (currentProject()) use it. */
  context?: { projectId?: string; boardId?: string };
};

export type LeafNode = Exclude<CqlNode, { op: "and" } | { op: "or" } | { op: "not" }>;

export function isLeaf(n: CqlNode): n is LeafNode {
  return n.op !== "and" && n.op !== "or" && n.op !== "not";
}

// ── zod ────────────────────────────────────────────────────────────────────

/** Free text in a JSON query. Postgres text can't hold U+0000, so it is refused up front. */
const text = (max: number) => z.string().max(max).refine((x) => !x.includes("\u0000"), "NUL characters aren't allowed.");

const fieldRefSchema: z.ZodType<FieldRef> = z.union([
  z.strictObject({ kind: z.literal("sys"), id: z.enum(SYSTEM_FIELD_IDS) }),
  z.strictObject({ kind: z.literal("cf"), key: z.string().regex(/^[A-Za-z0-9_]{1,100}$/) }),
]);

const valueSchema: z.ZodType<CqlValue> = z.lazy(() =>
  z.union([
    z.strictObject({ t: z.literal("str"), v: text(500) }),
    z.strictObject({ t: z.literal("num"), v: z.number().finite() }),
    z.strictObject({ t: z.literal("bool"), v: z.boolean() }),
    z.strictObject({
      t: z.literal("date"),
      v: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/),
    }),
    z.strictObject({ t: z.literal("rel"), v: z.string().regex(REL_RE) }),
    z.strictObject({
      t: z.literal("ref"),
      entity: z.enum(REF_ENTITIES),
      id: text(200).pipe(z.string().min(1)),
      label: text(500).optional(),
    }),
    z.strictObject({
      t: z.literal("fn"),
      name: z.enum(FUNCTION_NAMES),
      args: z.array(valueSchema).max(4),
    }),
    z.strictObject({ t: z.literal("var"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/) }),
    z.strictObject({ t: z.literal("empty") }),
  ]),
);

const predValueSchema = z.union([valueSchema, z.array(valueSchema).max(CQL_LIMITS.inValues)]);
const predsSchema: z.ZodType<HistoryPreds> = z.strictObject({
  from: predValueSchema.optional(),
  to: predValueSchema.optional(),
  by: predValueSchema.optional(),
  after: valueSchema.optional(),
  before: valueSchema.optional(),
  on: valueSchema.optional(),
  during: z.tuple([valueSchema, valueSchema]).optional(),
});

const nodeSchema: z.ZodType<CqlNode> = z.lazy(() =>
  z.union([
    z.strictObject({ op: z.literal("and"), args: z.array(nodeSchema).min(2).max(CQL_LIMITS.clauses) }),
    z.strictObject({ op: z.literal("or"), args: z.array(nodeSchema).min(2).max(CQL_LIMITS.clauses) }),
    z.strictObject({ op: z.literal("not"), arg: nodeSchema }),
    z.strictObject({
      op: z.literal("cmp"),
      field: fieldRefSchema,
      cmp: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
      value: valueSchema,
    }),
    z.strictObject({
      op: z.literal("in"),
      field: fieldRefSchema,
      negate: z.boolean().optional(),
      all: z.boolean().optional(),
      values: z.array(valueSchema).min(1).max(CQL_LIMITS.inValues),
    }),
    z.strictObject({ op: z.literal("empty"), field: fieldRefSchema, negate: z.boolean().optional() }),
    z.strictObject({
      op: z.literal("text"),
      field: fieldRefSchema,
      negate: z.boolean().optional(),
      query: text(500).pipe(z.string().min(1)),
    }),
    z.strictObject({
      op: z.literal("was"),
      field: fieldRefSchema,
      negate: z.boolean().optional(),
      values: z.array(valueSchema).min(1).max(CQL_LIMITS.inValues),
      preds: predsSchema.optional(),
    }),
    z.strictObject({ op: z.literal("changed"), field: fieldRefSchema, preds: predsSchema.optional() }),
  ]),
);

const sortSchema: z.ZodType<CqlSort> = z.strictObject({
  field: fieldRefSchema,
  dir: z.enum(["asc", "desc"]),
  nulls: z.enum(["first", "last"]).optional(),
});

/** Shape only. Size limits are `validateAst`'s job (a schema can't count depth). */
export const cqlQuerySchema: z.ZodType<CqlQuery> = z.strictObject({
  v: z.literal(CQL_VERSION),
  where: nodeSchema.nullable(),
  orderBy: z.array(sortSchema).max(CQL_LIMITS.sortKeys).optional(),
  context: z
    .strictObject({ projectId: text(200).optional(), boardId: text(200).optional() })
    .optional(),
});

// ── walking ───────────────────────────────────────────────────────────────

export function walkLeaves(n: CqlNode | null, visit: (leaf: LeafNode) => void): void {
  if (!n) return;
  if (n.op === "and" || n.op === "or") n.args.forEach((a) => walkLeaves(a, visit));
  else if (n.op === "not") walkLeaves(n.arg, visit);
  else visit(n);
}

/** Every value in a leaf, including history predicates and function arguments. */
export function leafValues(leaf: LeafNode): CqlValue[] {
  const out: CqlValue[] = [];
  const push = (v: CqlValue | undefined) => {
    if (!v) return;
    out.push(v);
    if (v.t === "fn") v.args.forEach(push);
  };
  if (leaf.op === "cmp") push(leaf.value);
  if (leaf.op === "in" || leaf.op === "was") leaf.values.forEach(push);
  if (leaf.op === "was" || leaf.op === "changed") {
    const p = leaf.preds ?? {};
    [...predValues(p.from), ...predValues(p.to), ...predValues(p.by), p.after, p.before, p.on, ...(p.during ?? [])].forEach(push);
  }
  return out;
}

/** How deep and/or/not nest. Iterative, and no spread: a node may have any number of args. */
export function nodeDepth(n: CqlNode | null): number {
  let max = 0;
  const stack: [CqlNode, number][] = n ? [[n, 1]] : [];
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (d > max) max = d;
    if (node.op === "and" || node.op === "or") for (const a of node.args) stack.push([a, d + 1]);
    else if (node.op === "not") stack.push([node.arg, d + 1]);
  }
  return max;
}

/** Does the query mention a field anywhere (including ORDER BY)? */
export function mentionsField(q: CqlQuery, id: SystemFieldId): boolean {
  let hit = false;
  walkLeaves(q.where, (l) => {
    if (l.field.kind === "sys" && l.field.id === id) hit = true;
  });
  return hit;
}

export function sameField(a: FieldRef, b: FieldRef): boolean {
  return a.kind === "sys" ? b.kind === "sys" && a.id === b.id : b.kind === "cf" && a.key === b.key;
}

/** AND two queries' predicates (dashboard filter bar ∧ panel, board baseline ∧ bar). */
export function andWhere(...nodes: (CqlNode | null | undefined)[]): CqlNode | null {
  const parts = nodes.filter((n): n is CqlNode => !!n);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { op: "and", args: parts };
}

export type { FunctionName, SystemFieldId };
