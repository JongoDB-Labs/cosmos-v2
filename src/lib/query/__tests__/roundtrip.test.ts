// parse(print(q)) ≡ q for every query, generated. The printer is how a stored
// query becomes text again (Advanced mode, Copy CQL, the assistant), so a query
// that does not survive the trip would change meaning on its way back in: the
// Jira bug that silently turned `is not empty` into `is empty` (JRASERVER-79024).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseCql } from "../parser";
import { printCql } from "../print";
import { queryArb } from "./arbitraries";

describe("print/parse round trip", () => {
  it("parse(print(q)) deep-equals q, with no diagnostics", () => {
    fc.assert(
      fc.property(queryArb, (q) => {
        const text = printCql(q);
        const back = parseCql(text);
        expect(back.diagnostics, text).toEqual([]);
        expect(back.query, text).toEqual(q);
      }),
      { numRuns: 2000 },
    );
  });

  it("print is stable: print(parse(print(q))) === print(q)", () => {
    fc.assert(
      fc.property(queryArb, (q) => {
        const once = printCql(q);
        expect(printCql(parseCql(once).query)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });
});
