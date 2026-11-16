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
  it("an insensitive equals is ILIKE too: its operand is unescaped, then compared exactly, ignoring case", () => {
    expect(matches({ k: { equals: "acme\\_2", mode: "insensitive" } }, { k: "ACME_2" })).toBe(true);
    expect(matches({ k: { equals: "acme\\_2", mode: "insensitive" } }, { k: "ACME-2" })).toBe(false);
    // Without the mode it is `=`, and the operand is the plain text.
    expect(matches({ k: { equals: "a_b" } }, { k: "a_b" })).toBe(true);
  });
  it("an insensitive equals unescapes a backslash and a percent sign too", () => {
    expect(matches({ k: { equals: "a\\\\b", mode: "insensitive" } }, { k: "A\\B" })).toBe(true);
    expect(matches({ k: { equals: "a\\\\b", mode: "insensitive" } }, { k: "A\\\\B" })).toBe(false);
    expect(matches({ k: { equals: "50\\%", mode: "insensitive" } }, { k: "50%" })).toBe(true);
    expect(matches({ k: { equals: "50\\%", mode: "insensitive" } }, { k: "500" })).toBe(false);
  });
  it("an insensitive not is NOT ILIKE: its operand is unescaped, then compared exactly, ignoring case", () => {
    expect(matches({ k: { not: "acme\\_2", mode: "insensitive" } }, { k: "ACME_2" })).toBe(false);
    expect(matches({ k: { not: "acme\\_2", mode: "insensitive" } }, { k: "ACME-2" })).toBe(true);
    expect(matches({ k: { not: "50\\%", mode: "insensitive" } }, { k: "50%" })).toBe(false);
    // NOT ILIKE on NULL is NULL, so the row is left out.
    expect(matches({ k: { not: "acme\\_2", mode: "insensitive" } }, { k: null })).toBe(false);
    // Without the mode it is `<>`, and the operand is the plain text.
    expect(matches({ k: { not: "a_b" } }, { k: "a_b" })).toBe(false);
    expect(matches({ k: { not: "a_b" } }, { k: "A_B" })).toBe(true);
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
  it("a to-one relation (`is`): decided on the row it is loaded on, FALSE where it is empty (as Prisma renders it), else undecided", () => {
    const onTeam = { assignee: { is: { memberships: { some: { removedAt: null, projectMembers: { some: { teamMembers: { some: { teamId: { in: ["t1"] } } } } } } } } } };
    const member = (removedAt: string | null, teamId: string) => ({ removedAt, projectMembers: [{ teamMembers: [{ teamId }] }] });
    expect(matches(onTeam, { assignee: { memberships: [member(null, "t1")] } })).toBe(true);
    expect(matches(onTeam, { assignee: { memberships: [member(null, "t2")] } })).toBe(false);
    expect(matches(onTeam, { assignee: { memberships: [member("2026-09-01T00:00:00.000Z", "t1")] } })).toBe(false);
    // No assignee: FALSE, and so its negation is TRUE (measured against Prisma).
    expect(evalWhere(onTeam, { assignee: null })).toBe(false);
    expect(matches({ NOT: onTeam }, { assignee: null })).toBe(true);
    // A board row: no relation, or the relation without the part asked about.
    expect(matches(onTeam, { assigneeId: "u1" })).toBe(UNDECIDED);
    expect(matches(onTeam, { assignee: { id: "u1", displayName: "U" } })).toBe(UNDECIDED);
    // A shape this interpreter wasn't written for: never a guess.
    expect(matches({ assignee: { is: null } }, { assignee: null })).toBe(UNDECIDED);
    expect(matches({ assignee: { is: { id: "u1" }, isNot: { id: "u2" } } }, { assignee: { id: "u1" } })).toBe(UNDECIDED);
  });
});

/**
 * The board is the SECOND executor of a compiled predicate: it filters its own
 * rows in the browser and asks the server only about rows it cannot decide
 * (use-board-query.ts keeps an UNDECIDED row only if the server's id set has
 * it). For `hasAttachments` a wrong YES in here would be exactly the disclosure
 * the server-side fragment exists to prevent, so the only acceptable answers
 * are the right one and UNDECIDED.
 */
describe("evaluate: hasChildren / hasAttachments on a board row", () => {
  const HAS_LIVE_CHILD = { children: { some: { archivedAt: null } } };
  const IS_LEAF = { children: { none: { archivedAt: null } } };
  const VISIBLE_DOC = {
    OR: [{ visibility: "INHERIT" }, { visibility: "RESTRICTED", OR: [{ uploadedById: "me" }] }],
  };

  it("decides a leaf from an empty children array and asks the server for the rest", () => {
    // The project work-items route DOES send `children`, with a select that
    // carries no archivedAt — so a row that HAS children cannot be decided here.
    expect(matches(HAS_LIVE_CHILD, { id: "i", children: [] })).toBe(false);
    expect(matches(IS_LEAF, { id: "i", children: [] })).toBe(true);
    expect(matches(HAS_LIVE_CHILD, { id: "i", children: [{ id: "c", title: "kid" }] })).toBe(UNDECIDED);
    expect(matches(IS_LEAF, { id: "i", children: [{ id: "c", title: "kid" }] })).toBe(UNDECIDED);
  });

  it("never counts a file whose visibility the row omits", () => {
    expect(matches({ documents: { some: VISIBLE_DOC } }, { id: "i" })).toBe(UNDECIDED);
    // Even if a row ever started carrying documents, one without the columns the
    // policy reads stays UNDECIDED rather than being counted as visible.
    expect(matches({ documents: { some: VISIBLE_DOC } }, { id: "i", documents: [{ id: "d" }] })).toBe(UNDECIDED);
    // "No files at all" is the one case it may answer by itself.
    expect(matches({ documents: { some: VISIBLE_DOC } }, { id: "i", documents: [] })).toBe(false);
    expect(matches({ documents: { none: VISIBLE_DOC } }, { id: "i", documents: [] })).toBe(true);
  });
});
