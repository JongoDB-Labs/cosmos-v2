// cqlTextArb feeds the scope properties (scope.db.test.ts). A draw over one of
// the parser's limits fails them on CQL_LIMIT instead of on what they check,
// and only at random: one CI run drew a query six parentheses deep. Pure, so
// it needs no database. Every limit here is read through the parser itself.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { cqlTextArb } from "./arbitraries";
import { parseCql } from "../parser";
import { countClauses, limitDiagnostics } from "../normalize";
import { CQL_LIMITS, nodeDepth } from "../ast";

/** Shaped like the properties' clauses: plain, with a call's parentheses, and longer than their longest. */
const clause = fc.constantFrom("priority >= HIGH", "childrenOf(ACME-1)", 'comment !~ "hid0a1b2c3d"', `assignee IN membersOf("${"x".repeat(40)}")`);

/** The errors executeCql's text path reports before it runs anything. */
function errors(text: string): string[] {
  const parsed = parseCql(text);
  return [...parsed.diagnostics, ...limitDiagnostics(parsed.query, text)].filter((d) => d.severity === "error").map((d) => d.message);
}

function shape(texts: string[]) {
  const queries = texts.map((t) => parseCql(t).query);
  return {
    broken: texts.filter((t) => errors(t).length > 0),
    // Fine as it is, refused inside one more pair of parentheses.
    atParenLimit: texts.filter((t) => errors(t).length === 0 && errors(`(${t})`).length > 0).length,
    deepest: Math.max(...queries.map((q) => nodeDepth(q.where))),
    mostClauses: Math.max(...queries.map((q) => countClauses(q).clauses)),
  };
}

describe("cqlTextArb stays inside the parser's limits", () => {
  it("when every draw runs into the budgets, and still reaches each limit", () => {
    const s = shape(fc.sample(cqlTextArb(clause, { clauseWeight: 0, depthSize: "max" }), { numRuns: 500, seed: 1 }));
    expect(s.broken).toEqual([]);
    expect(s.atParenLimit).toBeGreaterThan(0);
    expect(s.deepest).toBe(CQL_LIMITS.nodeDepth);
    expect(s.mostClauses).toBeGreaterThan(CQL_LIMITS.clauses * 0.8);
  });

  it("as the scope properties draw, still reaching the deepest grouping", () => {
    const s = shape(fc.sample(cqlTextArb(clause), { numRuns: 20_000, seed: 1 }));
    expect(s.broken).toEqual([]);
    expect(s.atParenLimit).toBeGreaterThan(0);
  });
});
