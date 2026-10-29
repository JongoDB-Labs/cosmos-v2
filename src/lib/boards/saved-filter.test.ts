import { describe, it, expect } from "vitest";
import { boardScope, inBoardScope } from "./saved-filter";

const row = {
  id: "i1", workItemTypeId: "t", columnKey: "todo", priority: "HIGH", assigneeId: null, assignees: [],
  tags: [], intervalId: null, parentId: null, title: "Login bug", description: null, customFields: {},
  archivedAt: null, startDate: null, dueDate: null, createdAt: "2026-10-01", updatedAt: "2026-10-01",
};

describe("boardScope", () => {
  it("no config / no savedFilter → none (everything in scope)", () => {
    expect(boardScope(undefined)).toEqual({ kind: "none" });
    expect(boardScope({ typeKeys: ["bug"] })).toEqual({ kind: "none" });
    expect(inBoardScope(boardScope(null), row)).toBe(true);
  });
  it("reads the saved filter and drops a stored project list", () => {
    const s = boardScope({ savedFilter: { priorities: ["HIGH"], projectIds: ["elsewhere"] } });
    expect(s).toEqual({ kind: "filter", filter: { priorities: ["HIGH"] } });
    expect(inBoardScope(s, row)).toBe(true);
    expect(inBoardScope(s, { ...row, priority: "LOW" })).toBe(false);
  });
  it("an unreadable saved filter is invalid and matches nothing", () => {
    const s = boardScope({ savedFilter: { priorities: ["NOPE"] } });
    expect(s.kind).toBe("invalid");
    expect(inBoardScope(s, row)).toBe(false);
  });
  it("a filter the board can't evaluate (watchers) is invalid, not ignored", () => {
    const s = boardScope({ savedFilter: { watchedByUserId: "u1" } });
    expect(s.kind).toBe("invalid");
    expect(inBoardScope(s, row)).toBe(false);
  });
  // A board saved from Issues with the query language ON stores `config.query`,
  // and `savedFilter` only when the legacy shape can express that query. This
  // reader cannot read `query`, so answering "none" for such a board put every
  // item in the project in scope.
  it("a board with only a stored query is invalid, NOT everything", () => {
    const s = boardScope({ query: { v: 1, where: { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } } } });
    expect(s.kind).toBe("invalid");
    expect(inBoardScope(s, row)).toBe(false);
    // ...and it says why, rather than showing an unexplained empty board.
    expect(s.kind === "invalid" && s.reason).toMatch(/query language/);
  });
  it("positive control: a query ALONGSIDE a readable savedFilter still reads the filter", () => {
    const s = boardScope({ query: { v: 1, where: null }, savedFilter: { priorities: ["HIGH"] } });
    expect(s).toEqual({ kind: "filter", filter: { priorities: ["HIGH"] } });
    expect(inBoardScope(s, row)).toBe(true);
    expect(inBoardScope(s, { ...row, priority: "LOW" })).toBe(false);
  });
  it("negative control: the new guard fires on `query` only, not on any config key", () => {
    expect(boardScope({ typeKeys: ["bug"], wipHardEnforce: true })).toEqual({ kind: "none" });
    expect(boardScope({ query: null })).toEqual({ kind: "none" });
  });
});
