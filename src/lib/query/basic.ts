/**
 * Basic mode: a query as a row of chips, and back, without losing anything.
 *
 * A chip is one clause, `[Field ▾] [operator ▾] [value(s) ▾] [×]` (Linear's
 * anatomy), plus a date/number RANGE chip for a `>=`/`<=` pair. A query is
 * basic-representable iff (design §9.2):
 *   1. `where` is null, one clause, or a top-level AND (or OR, "Match any") of
 *      clauses;
 *   2. every clause is IN / = / != / comparison / IS [NOT] EMPTY / ~, or a
 *      `>=`/`<=` pair on one field under AND (a range);
 *   3. no NOT nodes (negation is an operator: "is none of", "does not contain");
 *   4. no history operators, and no functions but `me`, the date functions and
 *      dashboard variables;
 *   5. at most one chip per field.
 * ORDER BY is not a chip; it rides along unchanged.
 *
 * When a query is not representable, `toChips` says why and WHERE, so the
 * Basic button can be disabled with a reason instead of Jira's opaque "too
 * complex" (or worse, a silent rewrite: JRASERVER-79024). The guarantee,
 * property-tested: `fromChips(toChips(q)) ≡ normalize(q)` for every q it accepts.
 *
 * Pure and client-safe.
 */
import {
  CQL_VERSION,
  sameField,
  type CmpOp,
  type CqlNode,
  type CqlQuery,
  type CqlValue,
  type FieldRef,
  type LeafNode,
} from "./ast";
import { normalize } from "./normalize";

export type Chip =
  | { kind: "in"; field: FieldRef; negate?: boolean; all?: boolean; values: CqlValue[] }
  | { kind: "cmp"; field: FieldRef; cmp: CmpOp; value: CqlValue }
  | { kind: "empty"; field: FieldRef; negate?: boolean }
  | { kind: "text"; field: FieldRef; negate?: boolean; query: string }
  /** `field >= from AND field <= to`, in that order. */
  | { kind: "range"; field: FieldRef; from: CqlValue; to: CqlValue };

export type ChipsResult =
  | { ok: true; chips: Chip[]; matchAny: boolean; orderBy: CqlQuery["orderBy"] }
  | { ok: false; reason: string; at?: CqlNode };

const BASIC_FUNCTIONS = new Set([
  "currentUser",
  "now",
  "startOfDay",
  "startOfWeek",
  "startOfMonth",
  "startOfYear",
  "endOfDay",
  "endOfWeek",
  "endOfMonth",
  "endOfYear",
  "sinceLastStandup",
]);

function valueOk(v: CqlValue): boolean {
  return v.t !== "fn" || BASIC_FUNCTIONS.has(v.name);
}

function leafToChip(n: LeafNode): Chip | string {
  switch (n.op) {
    case "in":
      if (!n.values.every(valueOk)) return "uses a function chips can't show";
      // No chip operator says "lacks at least one of".
      if (n.negate && n.all) return "uses NOT IN ALL";
      return { kind: "in", field: n.field, ...(n.negate ? { negate: true } : {}), ...(n.all ? { all: true } : {}), values: n.values };
    case "cmp":
      if (!valueOk(n.value)) return "uses a function chips can't show";
      return { kind: "cmp", field: n.field, cmp: n.cmp, value: n.value };
    case "empty":
      return { kind: "empty", field: n.field, ...(n.negate ? { negate: true } : {}) };
    case "text":
      return { kind: "text", field: n.field, ...(n.negate ? { negate: true } : {}), query: n.query };
    case "was":
    case "changed":
      return "uses history (WAS / CHANGED)";
  }
}

export function chipToNodes(c: Chip): CqlNode[] {
  switch (c.kind) {
    case "in":
      return [{ op: "in", field: c.field, ...(c.negate ? { negate: true } : {}), ...(c.all ? { all: true } : {}), values: c.values }];
    case "cmp":
      return [{ op: "cmp", field: c.field, cmp: c.cmp, value: c.value }];
    case "empty":
      return [{ op: "empty", field: c.field, ...(c.negate ? { negate: true } : {}) }];
    case "text":
      return [{ op: "text", field: c.field, ...(c.negate ? { negate: true } : {}), query: c.query }];
    case "range":
      return [
        { op: "cmp", field: c.field, cmp: "gte", value: c.from },
        { op: "cmp", field: c.field, cmp: "lte", value: c.to },
      ];
  }
}

export function toChips(input: CqlQuery): ChipsResult {
  const q = normalize(input);
  const done = (chips: Chip[], matchAny: boolean): ChipsResult => ({ ok: true, chips, matchAny, orderBy: q.orderBy });
  if (!q.where) return done([], false);

  const top = q.where;
  const isGroup = top.op === "and" || top.op === "or";
  const matchAny = top.op === "or";
  const parts: CqlNode[] = isGroup ? top.args : [top];

  const isRange = (a: CqlNode | undefined, b: CqlNode | undefined): a is Extract<CqlNode, { op: "cmp" }> =>
    a?.op === "cmp" && a.cmp === "gte" && b?.op === "cmp" && b.cmp === "lte" && sameField(a.field, b.field)
    && valueOk(a.value) && valueOk(b.value);

  const chips: Chip[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parts[i];
    // Under "Match any", a range is its own AND group of exactly that pair.
    if (matchAny && n.op === "and" && n.args.length === 2 && isRange(n.args[0], n.args[1])) {
      const [a, b] = n.args as Extract<CqlNode, { op: "cmp" }>[];
      chips.push({ kind: "range", field: a.field, from: a.value, to: b.value });
      continue;
    }
    if (n.op === "and" || n.op === "or") {
      return { ok: false, reason: n.op === top.op ? "has nested groups" : "mixes AND and OR", at: n };
    }
    if (n.op === "not") return { ok: false, reason: "uses NOT", at: n };
    // A `>=` then `<=` on one field under AND is a range chip.
    const next = parts[i + 1];
    if (!matchAny && isRange(n, next)) {
      chips.push({ kind: "range", field: n.field, from: n.value, to: (next as Extract<CqlNode, { op: "cmp" }>).value });
      i++;
      continue;
    }
    const c = leafToChip(n);
    if (typeof c === "string") return { ok: false, reason: c, at: n };
    chips.push(c);
  }

  for (let i = 0; i < chips.length; i++) {
    for (let j = i + 1; j < chips.length; j++) {
      if (sameField(chips[i].field, chips[j].field)) {
        return { ok: false, reason: "has two conditions on one field" };
      }
    }
  }
  return done(chips, matchAny);
}

export function fromChips(chips: Chip[], matchAny: boolean, orderBy?: CqlQuery["orderBy"]): CqlQuery {
  // A range chip is two clauses; under "Match any" they must stay together.
  const grouped: CqlNode[] = matchAny
    ? chips.map((c) => {
        const ns = chipToNodes(c);
        return ns.length === 1 ? ns[0] : { op: "and", args: ns };
      })
    : chips.flatMap(chipToNodes);
  const where: CqlNode | null =
    grouped.length === 0 ? null : grouped.length === 1 ? grouped[0] : { op: matchAny ? "or" : "and", args: grouped };
  return normalize({ v: CQL_VERSION, where, ...(orderBy?.length ? { orderBy } : {}) });
}
