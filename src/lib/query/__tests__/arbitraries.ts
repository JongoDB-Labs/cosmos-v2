/**
 * fast-check generators for CqlQuery, shared by the round-trip, typecheck and
 * scope-escape property tests.
 */
import fc from "fast-check";
import { CQL_LIMITS, CQL_VERSION, type CqlNode, type CqlQuery, type CqlSort, type CqlValue, type FieldRef, type HistoryPreds } from "../ast";
import { SYSTEM_FIELD_IDS } from "../fields";
import { FUNCTION_NAMES } from "../functions";

const TRICKY_STRINGS = [
  "HIGH", "Bug", "in-progress", "ACME-12", "Dana Ruiz", "and", "OR", "me", "true", "EMPTY", "-7d", "2026-01-01",
  "12", "", "a,b", 'say "hi"', "back\\slash", "line\nbreak", "ünïcode", "$notavar", "x*", "(paren", "orders",
];

export const fieldArb: fc.Arbitrary<FieldRef> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...SYSTEM_FIELD_IDS).map((id): FieldRef => ({ kind: "sys", id })) },
  { weight: 1, arbitrary: fc.constantFrom("severity", "Story Points", "order", "a-b").map((key): FieldRef => ({ kind: "cf", key })) },
);

const relArb = fc
  .tuple(fc.constantFrom("", "+", "-"), fc.integer({ min: 0, max: 99999 }), fc.constantFrom("wd", "y", "M", "w", "d", "h", "m"))
  .map(([s, n, u]) => `${s}${n}${u}`);

export const scalarValueArb: fc.Arbitrary<CqlValue> = fc.oneof(
  fc.oneof(fc.constantFrom(...TRICKY_STRINGS), fc.string({ minLength: 0, maxLength: 12 })).map((v): CqlValue => ({ t: "str", v })),
  fc.integer({ min: -100000, max: 100000 }).map((v): CqlValue => ({ t: "num", v })),
  fc.integer({ min: -10000, max: 10000 }).map((v): CqlValue => ({ t: "num", v: v / 100 })),
  fc.boolean().map((v): CqlValue => ({ t: "bool", v })),
  fc.constantFrom("2026-10-31", "2026-01-01T09:30:00Z", "2025-02-28T23:59:59.999+05:30").map((v): CqlValue => ({ t: "date", v })),
  relArb.map((v): CqlValue => ({ t: "rel", v })),
  fc.constantFrom("speaker", "team", "project", "_x9").map((name): CqlValue => ({ t: "var", name })),
);

export const valueArb: fc.Arbitrary<CqlValue> = fc.oneof(
  { weight: 4, arbitrary: scalarValueArb },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...FUNCTION_NAMES), fc.array(scalarValueArb, { maxLength: 2 }))
      .map(([name, args]): CqlValue => ({ t: "fn", name, args })),
  },
);

const listArb = fc.array(fc.oneof({ weight: 6, arbitrary: valueArb }, { weight: 1, arbitrary: fc.constant<CqlValue>({ t: "empty" }) }), {
  minLength: 1,
  maxLength: 4,
});

const predsArb: fc.Arbitrary<HistoryPreds | undefined> = fc.option(
  fc.record(
    {
      from: valueArb,
      to: valueArb,
      by: valueArb,
      after: valueArb,
      before: valueArb,
      on: valueArb,
      during: fc.tuple(valueArb, valueArb),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
).map((p) => (p && Object.keys(p).length ? p : undefined));

const opt = <T extends object>(cond: boolean, v: T): T | object => (cond ? v : {});

export const leafArb: fc.Arbitrary<CqlNode> = fc.oneof(
  fc
    .tuple(fieldArb, fc.constantFrom("eq", "neq", "lt", "lte", "gt", "gte" as const), valueArb)
    .map(([field, cmp, value]) => ({ op: "cmp", field, cmp, value }) as CqlNode),
  fc
    .tuple(fieldArb, fc.boolean(), fc.boolean(), listArb)
    .map(([field, negate, all, values]) => ({ op: "in", field, ...opt(negate, { negate: true }), ...opt(all, { all: true }), values }) as CqlNode),
  fc.tuple(fieldArb, fc.boolean()).map(([field, negate]) => ({ op: "empty", field, ...opt(negate, { negate: true }) }) as CqlNode),
  fc
    .tuple(fieldArb, fc.boolean(), fc.oneof(fc.constantFrom(...TRICKY_STRINGS.filter(Boolean)), fc.string({ minLength: 1, maxLength: 10 })))
    .map(([field, negate, query]) => ({ op: "text", field, ...opt(negate, { negate: true }), query }) as CqlNode),
  fc
    .tuple(fieldArb, fc.boolean(), listArb, predsArb)
    .map(([field, negate, values, preds]) => ({ op: "was", field, ...opt(negate, { negate: true }), values, ...opt(!!preds, { preds }) }) as CqlNode),
  fc.tuple(fieldArb, predsArb).map(([field, preds]) => ({ op: "changed", field, ...opt(!!preds, { preds }) }) as CqlNode),
);

export const nodeArb: fc.Arbitrary<CqlNode> = fc.letrec<{ node: CqlNode }>((tie) => ({
  node: fc.oneof(
    { depthSize: "medium", maxDepth: 5, withCrossShrink: true },
    { weight: 5, arbitrary: leafArb },
    { weight: 1, arbitrary: fc.array(tie("node"), { minLength: 2, maxLength: 3 }).map((args) => ({ op: "and", args }) as CqlNode) },
    { weight: 1, arbitrary: fc.array(tie("node"), { minLength: 2, maxLength: 3 }).map((args) => ({ op: "or", args }) as CqlNode) },
    { weight: 1, arbitrary: tie("node").map((arg) => ({ op: "not", arg }) as CqlNode) },
  ),
})).node;

const sortArb: fc.Arbitrary<CqlSort> = fc
  .tuple(fieldArb, fc.constantFrom("asc", "desc" as const), fc.option(fc.constantFrom("first", "last" as const), { nil: undefined }))
  .map(([field, dir, nulls]) => ({ field, dir, ...(nulls ? { nulls } : {}) }));

export const queryArb: fc.Arbitrary<CqlQuery> = fc
  .tuple(fc.option(nodeArb, { nil: null }), fc.option(fc.array(sortArb, { minLength: 1, maxLength: 3 }), { nil: undefined }))
  .map(([where, orderBy]) => ({ v: CQL_VERSION, where, ...(orderBy ? { orderBy } : {}) }));

/**
 * CQL text joining `clause`s with AND, OR and NOT, inside every limit the
 * parser and `limitDiagnostics` put on text, so a property over it fails on
 * what it checks and never on CQL_LIMIT (fast-check once drew a query six
 * parentheses deep). Each side gets what its parent left of three budgets:
 *   - groups (CQL_LIMITS.parenDepth): OR and NOT each open one;
 *   - levels (CQL_LIMITS.nodeDepth, the clause itself being the first): AND,
 *     OR and NOT each add one. AND opens no group, so it is how a query nests
 *     deeper than its parentheses. A chain of ANDs is really one node, so
 *     this overcounts, which is the safe direction;
 *   - clauses (CQL_LIMITS.clauses): AND and OR halve theirs between the sides.
 * The other text limits follow: a NOT opens a group, so at most parenDepth
 * NOTs come in a row (the parser allows nodeDepth); a clause's own call
 * parentheses add one, within nodeDepth; and at the clause cap, clauses as
 * long as these properties' longest fill about half of textLength.
 *
 * The defaults are the weights and depth bias the scope properties always
 * used, and a draw changes only where a budget runs out: a query that broke a
 * limit, or a long AND / OR chain the budgets count conservatively (about 2
 * draws in 10,000). `clauseWeight: 0` with no depth bias draws a clause only
 * where nothing else fits, so every draw runs into the budgets: that is how
 * the bounds themselves are tested.
 */
export function cqlTextArb(
  clause: fc.Arbitrary<string>,
  { clauseWeight = 4, depthSize = "small" }: { clauseWeight?: number; depthSize?: fc.DepthSize } = {},
): fc.Arbitrary<string> {
  const depthIdentifier = fc.createDepthIdentifier();
  const built = new Map<string, fc.Arbitrary<string>>();
  const expr = (groups: number, levels: number, clauses: number): fc.Arbitrary<string> => {
    const key = `${groups}/${levels}/${clauses}`;
    const seen = built.get(key);
    if (seen) return seen;
    const sides = (g: number) => fc.tuple(expr(g, levels - 1, Math.ceil(clauses / 2)), expr(g, levels - 1, Math.floor(clauses / 2)));
    const joins: fc.WeightedArbitrary<string>[] = [];
    if (levels > 0 && groups > 0 && clauses > 1) joins.push({ weight: 1, arbitrary: sides(groups - 1).map(([a, b]) => `(${a} OR ${b})`) });
    if (levels > 0 && clauses > 1) joins.push({ weight: 1, arbitrary: sides(groups).map(([a, b]) => `${a} AND ${b}`) });
    if (levels > 0 && groups > 0) joins.push({ weight: 1, arbitrary: expr(groups - 1, levels - 1, clauses).map((a) => `NOT (${a})`) });
    // The clause comes first: it is what the depth bias favours.
    const arb = fc.oneof({ depthSize, depthIdentifier }, { weight: Math.max(clauseWeight, joins.length ? 0 : 1), arbitrary: clause }, ...joins);
    built.set(key, arb);
    return arb;
  };
  return expr(CQL_LIMITS.parenDepth, CQL_LIMITS.nodeDepth - 1, CQL_LIMITS.clauses);
}
