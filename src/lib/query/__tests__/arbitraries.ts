/**
 * fast-check generators for CqlQuery, shared by the round-trip, typecheck and
 * scope-escape property tests.
 */
import fc from "fast-check";
import { CQL_VERSION, type CqlNode, type CqlQuery, type CqlSort, type CqlValue, type FieldRef, type HistoryPreds } from "../ast";
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
