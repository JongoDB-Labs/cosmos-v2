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

describe("JSON size is measured before anything recursive touches it", () => {
  const deepNot = (n: number): unknown => {
    let node: unknown = { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } };
    for (let i = 0; i < n; i++) node = { op: "not", arg: node };
    return { v: CQL_VERSION, where: node };
  };
  it("thousands of nested NOTs are a limit diagnostic, not a crash", () => {
    const r = validateAst(deepNot(5000));
    expect(r.query).toBeNull();
    expect(r.diagnostics[0]).toMatchObject({ code: "CQL_LIMIT" });
  });
  it("an AND with 123,000 args is refused, and fast", () => {
    const leaf = { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } };
    const t0 = Date.now();
    const r = validateAst({ v: CQL_VERSION, where: { op: "and", args: Array.from({ length: 123_000 }, () => leaf) } });
    expect(r.query).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Just over the clause limit: zod's cap says so, as a shape error.
    const r2 = validateAst({ v: CQL_VERSION, where: { op: "and", args: Array.from({ length: CQL_LIMITS.clauses + 1 }, () => leaf) } });
    expect(r2.query).toBeNull();
  });
  it("nodeDepth survives very wide nodes (no spread into Math.max)", async () => {
    const { nodeDepth } = await import("../ast");
    const leaf = { op: "empty", field: { kind: "sys", id: "due" } } as CqlNode;
    expect(nodeDepth({ op: "and", args: Array.from({ length: 200_000 }, () => leaf) })).toBe(2);
    expect(nodeDepth({ op: "not", arg: { op: "or", args: [leaf, { op: "not", arg: leaf }] } })).toBe(4);
  });
});
