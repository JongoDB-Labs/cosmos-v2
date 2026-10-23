import { describe, it, expect, vi } from "vitest";
import { paritySampleRate, scheduleParity } from "../parity.server";
import { fromWorkItemFilter } from "../adapters";

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
