// Adding ONE condition to a query of any shape.
//
// Reported (FR ad579c82): "i should simply be able to add the filters from the
// dropdown on the right". Today "Add filter" lives in Basic mode only, and
// Basic mode refuses any query with a group, an OR-of-ANDs, a NOT or a history
// operator — so on exactly those queries there is no filter dropdown at all.
//
// The tests that matter here are the ones where the existing query is one
// chips CANNOT represent. Those are the queries the feature exists for, and
// the OR case is where a naive implementation changes the meaning silently:
// `a OR b` plus `c` must be `(a OR b) AND c`, never `a OR b AND c`.
import { describe, it, expect } from "vitest";
import { appendChip, fieldsIn } from "./append-clause";
import { toChips } from "./basic";
import { parseCql } from "./parser";
import type { Chip } from "./basic";

const TYPE_BUG: Chip = { kind: "in", field: { kind: "sys", id: "type" }, values: [{ t: "str", v: "BUG" }] };
const MINE: Chip = { kind: "cmp", field: { kind: "sys", id: "assignee" }, cmp: "eq", value: { t: "fn", name: "currentUser", args: [] } };

const ok = (r: ReturnType<typeof appendChip>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.cql;
};

describe("appendChip", () => {
  it("writes the whole query when there was none", () => {
    expect(ok(appendChip("", TYPE_BUG))).toBe("type IN (BUG)");
    expect(ok(appendChip("   ", MINE))).toBe("assignee = me");
  });

  it("extends a flat AND without nesting it", () => {
    expect(ok(appendChip("status = Done AND priority = HIGH", TYPE_BUG))).toBe(
      "status = Done AND priority = HIGH AND type IN (BUG)",
    );
  });

  it("ANDs onto a single clause", () => {
    expect(ok(appendChip("status = Done", TYPE_BUG))).toBe("status = Done AND type IN (BUG)");
  });

  // The one that would silently change what the user sees.
  it("parenthesises a top-level OR instead of binding the new clause to its last arm", () => {
    const out = ok(appendChip("status = Done OR status = Blocked", TYPE_BUG));
    expect(out).toBe("(status = Done OR status = Blocked) AND type IN (BUG)");
    // Not just the text: the tree must be an AND of the OR and the new clause.
    const where = parseCql(out).query.where!;
    expect(where.op).toBe("and");
    expect(where.op === "and" && where.args[0].op).toBe("or");
  });

  it("keeps a NOT whole", () => {
    const out = ok(appendChip("NOT (status = Done)", MINE));
    expect(parseCql(out).query.where!.op).toBe("and");
    expect(out).toContain("NOT");
    expect(out).toContain("assignee = me");
  });

  // The queries this feature exists for: ones Basic mode refuses outright.
  it.each([
    ["mixed AND/OR", "(status = Done AND priority = HIGH) OR type IN (BUG)"],
    ["a history operator", "status WAS Done AFTER -7d"],
    ["two conditions on one field", "points > 3 AND points < 8"],
  ])("appends to a query chips cannot show (%s)", (_name, cql) => {
    // Positive control: this really is a query Basic mode refuses, so the test
    // is not quietly passing over a query that chips could have handled.
    expect(toChips(parseCql(cql).query).ok).toBe(false);

    const out = ok(appendChip(cql, TYPE_BUG));
    const parsed = parseCql(out);
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(out).toContain("type IN (BUG)");
    expect(parsed.query.where!.op).toBe("and");
  });

  it("carries ORDER BY through", () => {
    expect(ok(appendChip("status = Done ORDER BY due ASC", TYPE_BUG))).toBe(
      "status = Done AND type IN (BUG) ORDER BY due ASC",
    );
  });

  it("refuses a query that does not parse, rather than reprinting it without the broken part", () => {
    const r = appendChip("status = ", TYPE_BUG);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/syntax error/);
  });

  it("writes both halves of a range chip", () => {
    const range: Chip = {
      kind: "range",
      field: { kind: "sys", id: "points" },
      from: { t: "num", v: 3 },
      to: { t: "num", v: 8 },
    };
    expect(ok(appendChip("status = Done", range))).toBe("status = Done AND points >= 3 AND points <= 8");
    // And onto an OR, where both halves must land inside the same AND —
    // `points >= 3` binding to the OR's last arm would widen the result set.
    expect(ok(appendChip("status = Done OR status = Blocked", range))).toBe(
      "(status = Done OR status = Blocked) AND points >= 3 AND points <= 8",
    );
  });
});

describe("fieldsIn", () => {
  it("reaches inside groups and NOT, where a flat scan of the top level would not", () => {
    const names = fieldsIn("(status = Done AND priority = HIGH) OR NOT (type IN (BUG))").map((f) =>
      f.kind === "sys" ? f.id : f.key,
    );
    expect(new Set(names)).toEqual(new Set(["status", "priority", "type"]));
  });

  it("lists a field once however often it appears", () => {
    expect(fieldsIn("points > 3 AND points < 8")).toHaveLength(1);
  });

  it("finds the field of a history clause", () => {
    expect(fieldsIn("status WAS Done AFTER -7d").map((f) => (f.kind === "sys" ? f.id : f.key))).toEqual(["status"]);
  });

  it("says nothing about a query that does not parse", () => {
    expect(fieldsIn("status = ")).toEqual([]);
    expect(fieldsIn("")).toEqual([]);
  });
});
