// The interpreter's SQL semantics, case by case (the DB conformance test is in
// evaluate.db.test.ts).
import { describe, it, expect } from "vitest";
import { UNDECIDED, evalWhere, matches } from "../evaluate";

describe("evaluate: SQL three-valued logic", () => {
  it("a comparison with NULL is unknown, and so is its negation", () => {
    expect(evalWhere({ x: { in: ["a"] } }, { x: null })).toBeNull();
    expect(evalWhere({ NOT: { x: { in: ["a"] } } }, { x: null })).toBeNull();
    expect(matches({ NOT: { x: { in: ["a"] } } }, { x: null })).toBe(false);
    expect(evalWhere({ x: { gte: 3 } }, { x: null })).toBeNull();
    expect(evalWhere({ x: "a" }, { x: null })).toBeNull();
  });
  it("IS NULL and IS NOT NULL are two-valued", () => {
    expect(evalWhere({ x: null }, { x: null })).toBe(true);
    expect(evalWhere({ x: { not: null } }, { x: null })).toBe(false);
    expect(evalWhere({ NOT: { x: null } }, { x: "a" })).toBe(true);
  });
  it("Kleene AND / OR: FALSE and TRUE win over unknown", () => {
    expect(evalWhere({ AND: [{ x: { in: ["a"] } }, { y: "b" }] }, { x: null, y: "c" })).toBe(false);
    expect(evalWhere({ OR: [{ x: { in: ["a"] } }, { y: "b" }] }, { x: null, y: "b" })).toBe(true);
    expect(evalWhere({ OR: [{ x: { in: ["a"] } }, { y: "b" }] }, { x: null, y: "c" })).toBeNull();
  });
  it("an empty IN is false and an empty NOT IN true, NULL or not (as Prisma renders them)", () => {
    expect(evalWhere({ x: { in: [] } }, { x: null })).toBe(false);
    expect(evalWhere({ x: { notIn: [] } }, { x: null })).toBe(true);
  });
});

describe("evaluate: values", () => {
  it("LIKE operands are unescaped: \\% is a literal percent", () => {
    expect(matches({ title: { contains: "50\\%", mode: "insensitive" } }, { title: "Save 50% Now" })).toBe(true);
    expect(matches({ title: { contains: "50\\%", mode: "insensitive" } }, { title: "Save 500 now" })).toBe(false);
    expect(matches({ title: { startsWith: "a\\_b" } }, { title: "a_bc" })).toBe(true);
  });
  it("instants compare as time, whatever their ISO spelling", () => {
    expect(matches({ d: { gte: "2026-10-20T00:00:00.000Z" } }, { d: "2026-10-19T20:00:00-05:00" })).toBe(true);
    expect(matches({ d: { lt: new Date("2026-10-20T00:00:00Z") } }, { d: "2026-10-19T23:59:59.999Z" })).toBe(true);
  });
  it("JSON paths: AnyNull is missing or JSON null; \"\" and [] are values", () => {
    const empty = { customFields: { path: ["k"], equals: { $null: "AnyNull" } } };
    expect(matches(empty, { customFields: {} })).toBe(true);
    expect(matches(empty, { customFields: { k: null } })).toBe(true);
    expect(matches(empty, { customFields: { k: "" } })).toBe(false);
    expect(matches({ customFields: { path: ["k"], equals: { $null: "JsonNull" } } }, { customFields: {} })).toBe(false);
    expect(matches({ customFields: { path: ["k"], array_contains: ["a"] } }, { customFields: { k: ["a", "b"] } })).toBe(true);
    expect(matches({ customFields: { path: ["k"], string_contains: "ACM", mode: "insensitive" } }, { customFields: { k: "acme" } })).toBe(true);
  });
  it("a relation or column the row doesn't carry is undecided, never a guess; an unknown operator too", () => {
    expect(matches({ labels: { some: { labelId: "l1" } } }, { id: "i" })).toBe(UNDECIDED);
    expect(matches({ comments: { none: {} } }, { id: "i" })).toBe(UNDECIDED);
    expect(matches({ resolution: "x" }, { id: "i" })).toBe(UNDECIDED);
    expect(matches({ x: { search: "y" } }, { x: "y" })).toBe(UNDECIDED);
    // …unless the answer doesn't depend on it.
    expect(matches({ AND: [{ id: "j" }, { labels: { some: { labelId: "l1" } } }] }, { id: "i" })).toBe(false);
  });
});
