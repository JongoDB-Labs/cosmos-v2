import { describe, it, expect, vi } from "vitest";
import { paritySampleRate, scheduleParity } from "../parity.server";
import { fromWorkItemFilter, toWorkItemFilter } from "../adapters";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { parseCql } from "../parser";

describe("dark-ship parity", () => {
  it("samples everything outside production, 5% in production, and honours an override", () => {
    expect(paritySampleRate({ NODE_ENV: "development" })).toBe(1);
    expect(paritySampleRate({ NODE_ENV: "production" })).toBe(0.05);
    expect(paritySampleRate({ NODE_ENV: "production", CQL_PARITY_SAMPLE: "0.5" })).toBe(0.5);
    expect(paritySampleRate({ CQL_PARITY_SAMPLE: "7" })).toBe(1);
    expect(paritySampleRate({ CQL_PARITY_SAMPLE: "nope" })).toBe(0);
  });

  it("never throws into the request, even with no request scope for after()", () => {
    const legacy = { data: [], total: 0 };
    expect(() =>
      scheduleParity({ userId: "u", orgId: "o" } as never, { filter: {}, sort: undefined, page: 1, pageSize: 25 }, legacy, () => 0),
    ).not.toThrow();
    const rand = vi.fn(() => 0.99);
    scheduleParity({ userId: "u", orgId: "o" } as never, { filter: {}, sort: undefined, page: 1, pageSize: 25 }, legacy, rand);
    expect(rand).toHaveBeenCalled();
  });
});

describe("fromWorkItemFilter", () => {
  it("maps sentinels and legacy text faithfully", () => {
    const q = fromWorkItemFilter({ assigneeIds: ["unassigned", "u1"], intervalIds: ["none"], text: "x", archived: "all" });
    expect(q.where).toEqual({
      op: "and",
      args: [
        {
          op: "or",
          args: [
            { op: "cmp", field: { kind: "sys", id: "archived" }, cmp: "eq", value: { t: "bool", v: true } },
            { op: "cmp", field: { kind: "sys", id: "archived" }, cmp: "eq", value: { t: "bool", v: false } },
          ],
        },
        { op: "in", field: { kind: "sys", id: "assignee" }, values: [{ t: "empty" }, { t: "ref", entity: "user", id: "u1" }] },
        { op: "in", field: { kind: "sys", id: "sprint" }, values: [{ t: "empty" }] },
        {
          op: "or",
          args: [
            { op: "text", field: { kind: "sys", id: "summary" }, query: "x" },
            { op: "text", field: { kind: "sys", id: "description" }, query: "x" },
          ],
        },
      ],
    });
  });
  it("an empty filter is everything; sort maps to ORDER BY", () => {
    expect(fromWorkItemFilter({}, { field: "dueDate", direction: "asc" })).toEqual({
      v: 1,
      where: null,
      orderBy: [{ field: { kind: "sys", id: "due" }, dir: "asc" }],
    });
  });
});

describe("toWorkItemFilter (transitional reverse)", () => {
  const filters: WorkItemFilter[] = [
    {},
    { projectIds: ["p1", "p2"] },
    { ids: ["i1"] },
    { typeIds: ["t1"], columnKeys: ["todo", "done"] },
    { priorities: ["HIGH", "LOW"] },
    { assigneeIds: ["unassigned", "u1"] },
    { labels: ["auth", "urgent"] },
    { intervalIds: ["none", "s1"] },
    { watchedByUserId: "u1" },
    { archived: "only" },
    { archived: "all" },
    { parent: { mode: "has_parent" } },
    { parent: { mode: "no_parent" } },
    { parent: { mode: "is", parentIds: ["x"] } },
    { dueDate: { from: "2026-01-01", to: "2026-02-01" }, createdAt: { from: "2025-01-01" } },
    { text: "login" },
    { customFields: [{ key: "sev", kind: "SELECT", value: "S1" }, { key: "ok", kind: "CHECKBOX", value: true }] },
    { priorities: ["HIGH"], labels: ["auth"], assigneeIds: ["u1"], text: "x" },
  ];
  it("round-trips every legacy filter", () => {
    for (const f of filters) expect(toWorkItemFilter(fromWorkItemFilter(f), new Map([["sev", "SELECT"]])), JSON.stringify(f)).toEqual(f);
  });
  it("is null for what the legacy shape can't say", () => {
    for (const cql of ["priority = HIGH OR assignee = me", "NOT priority = HIGH", "assignee = me", "priority > LOW", "summary ~ x", "sprint IN openSprints()"]) {
      expect(toWorkItemFilter(parseCql(cql).query), cql).toBeNull();
    }
  });
});
