import { describe, it, expect } from "vitest";
import { hashQuery, normalize, validateAst } from "../normalize";
import { CQL_LIMITS, CQL_VERSION, type CqlNode, type CqlQuery } from "../ast";

const leaf = (n: number): CqlNode => ({ op: "cmp", field: { kind: "sys", id: "points" }, cmp: "eq", value: { t: "num", v: n } });

describe("normalize / hash", () => {
  it("flattens nested and/or, unwraps singletons, turns = EMPTY into IS EMPTY, keeps order", () => {
    const q: CqlQuery = {
      v: CQL_VERSION,
      where: { op: "and", args: [leaf(1), { op: "and", args: [leaf(2), { op: "or", args: [leaf(3)] }] }] },
    };
    expect(normalize(q).where).toEqual({ op: "and", args: [leaf(1), leaf(2), leaf(3)] });
    expect(
      normalize({ v: CQL_VERSION, where: { op: "cmp", field: { kind: "sys", id: "assignee" }, cmp: "neq", value: { t: "empty" } } }).where,
    ).toEqual({ op: "empty", field: { kind: "sys", id: "assignee" }, negate: true });
  });
  it("equal queries hash equally regardless of key order; different ones differ", () => {
    const a: CqlQuery = { v: CQL_VERSION, where: leaf(1) };
    const b = JSON.parse(JSON.stringify({ where: leaf(1), v: CQL_VERSION })) as CqlQuery;
    expect(hashQuery(a)).toBe(hashQuery(b));
    expect(hashQuery(a)).not.toBe(hashQuery({ v: CQL_VERSION, where: leaf(2) }));
    expect(hashQuery(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("validateAst — JSON queries", () => {
  it("accepts a valid query", () => {
    const r = validateAst({ v: 1, where: leaf(1), orderBy: [{ field: { kind: "sys", id: "due" }, dir: "asc" }] });
    expect(r.diagnostics).toEqual([]);
  });
  it("rejects bad shapes: unknown version, field, op, function, extra keys", () => {
    for (const bad of [
      { v: 2, where: null },
      { v: 1, where: { op: "cmp", field: { kind: "sys", id: "nope" }, cmp: "eq", value: { t: "num", v: 1 } } },
      { v: 1, where: { op: "xor", args: [] } },
      { v: 1, where: { op: "in", field: { kind: "sys", id: "sprint" }, values: [{ t: "fn", name: "dropTables", args: [] }] } },
      { v: 1, where: null, extra: true },
      { v: 1, where: { op: "and", args: [leaf(1)] } },
      { v: 1, where: { op: "cmp", field: { kind: "cf", key: "a b; drop" }, cmp: "eq", value: { t: "num", v: 1 } } },
    ]) {
      const r = validateAst(bad);
      expect(r.query, JSON.stringify(bad)).toBeNull();
      expect(r.diagnostics[0].code).toBe("CQL_INVALID_AST");
    }
  });
  it("enforces the size limits a schema can't express", () => {
    const many = { v: 1, where: { op: "and", args: Array.from({ length: CQL_LIMITS.clauses + 1 }, (_, i) => leaf(i)) } };
    expect(validateAst(many).diagnostics[0].code).toBe("CQL_LIMIT");
    let deep: CqlNode = leaf(0);
    for (let i = 0; i < CQL_LIMITS.nodeDepth + 1; i++) deep = { op: "not", arg: deep };
    expect(validateAst({ v: 1, where: deep }).diagnostics[0].code).toBe("CQL_LIMIT");
    const history = { v: 1, where: { op: "and", args: Array.from({ length: 4 }, () => ({ op: "changed", field: { kind: "sys", id: "status" } })) } };
    expect(validateAst(history).diagnostics[0].code).toBe("CQL_LIMIT");
  });
});
