import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fromChips, toChips } from "../basic";
import { normalize } from "../normalize";
import { parseCql } from "../parser";
import { queryArb } from "./arbitraries";

const chipsOf = (cql: string) => toChips(parseCql(cql).query);

describe("basic mode (chips)", () => {
  it("fromChips(toChips(q)) ≡ normalize(q) for every query chips can show", () => {
    let representable = 0;
    fc.assert(
      fc.property(queryArb, (q) => {
        const r = toChips(q);
        if (!r.ok) return;
        representable++;
        expect(fromChips(r.chips, r.matchAny, r.orderBy)).toEqual(normalize(q));
      }),
      { numRuns: 5000 },
    );
    expect(representable).toBeGreaterThan(500);
  });

  it("reads the usual shapes as chips", () => {
    const r = chipsOf("assignee = me AND priority IN (HIGH, CRITICAL) AND due >= startOfWeek() AND due <= endOfWeek() ORDER BY due");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chips.map((c) => c.kind)).toEqual(["cmp", "in", "range"]);
    expect(r.matchAny).toBe(false);
    expect(r.orderBy).toHaveLength(1);
  });

  it("match any is a top-level OR, and a range survives inside it", () => {
    const r = chipsOf("priority = HIGH OR (created >= -7d AND created <= now())");
    expect(r.ok && r.matchAny).toBe(true);
    expect(r.ok && r.chips.map((c) => c.kind)).toEqual(["cmp", "range"]);
  });

  it("says why, and where, a query can't be shown as chips", () => {
    const cases: [string, RegExp][] = [
      ["priority = HIGH AND (a = 1 OR b = 2)", /AND and OR/],
      ["NOT priority = HIGH", /NOT/],
      ["status WAS done", /history/],
      ["sprint IN openSprints()", /function/],
      ["priority = HIGH AND priority != LOW", /two conditions/],
    ];
    for (const [cql, reason] of cases) {
      const r = chipsOf(cql);
      expect(r.ok, cql).toBe(false);
      if (!r.ok) expect(r.reason, cql).toMatch(reason);
    }
  });
});
