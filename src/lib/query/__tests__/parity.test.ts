import { describe, it, expect, vi } from "vitest";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...((await orig()) as object), after }));

import { paritySampleRate, scheduleParity } from "../parity.server";
import { fromWorkItemFilter, toWorkItemFilter } from "../adapters";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { parseCql } from "../parser";

describe("dark-ship parity", () => {
  it("samples only orgs with CQL on (all outside production, 5% in it), unless a rate is set explicitly", () => {
    expect(paritySampleRate(true, { NODE_ENV: "development" })).toBe(1);
    expect(paritySampleRate(true, { NODE_ENV: "production" })).toBe(0.05);
    // An org without CQL is never sampled by default, in any environment.
    expect(paritySampleRate(false, { NODE_ENV: "development" })).toBe(0);
    expect(paritySampleRate(false, { NODE_ENV: "production" })).toBe(0);
    // An explicit rate applies to every org, clamped to 0..1.
    expect(paritySampleRate(false, { NODE_ENV: "production", COSMOS_CQL_PARITY_RATE: "0.5" })).toBe(0.5);
    expect(paritySampleRate(true, { NODE_ENV: "production", COSMOS_CQL_PARITY_RATE: "0" })).toBe(0);
    expect(paritySampleRate(false, { COSMOS_CQL_PARITY_RATE: "7" })).toBe(1);
    expect(paritySampleRate(true, { COSMOS_CQL_PARITY_RATE: "nope" })).toBe(0);
  });

  it("never schedules a second query for an org without CQL, by default", () => {
    vi.stubEnv("COSMOS_CQL_PARITY_RATE", "");
    after.mockClear();
    const legacy = { data: [], total: 0 };
    const args = { filter: {}, sort: undefined, page: 1, pageSize: 25 };
    scheduleParity({ userId: "u", orgId: "o" } as never, args, legacy, false, () => 0);
    expect(after).not.toHaveBeenCalled();
    scheduleParity({ userId: "u", orgId: "o" } as never, args, legacy, true, () => 0);
    expect(after).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it("never throws into the request, even with no request scope for after()", () => {
    after.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const legacy = { data: [], total: 0 };
    expect(() =>
      scheduleParity({ userId: "u", orgId: "o" } as never, { filter: {}, sort: undefined, page: 1, pageSize: 25 }, legacy, true, () => 0),
    ).not.toThrow();
    const rand = vi.fn(() => 0.99);
    scheduleParity({ userId: "u", orgId: "o" } as never, { filter: {}, sort: undefined, page: 1, pageSize: 25 }, legacy, true, rand);
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
