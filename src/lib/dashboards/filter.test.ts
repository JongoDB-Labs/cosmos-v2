import { describe, expect, it } from "vitest";
import { Priority } from "@prisma/client";
import {
  ANY,
  EMPTY_DASHBOARD_FILTER,
  applyStateToFilter,
  groupRowsByStatus,
  isEmptyFilterState,
  workItemFilterToSearchParams,
  workItemFilterToState,
  type DashboardFilterState,
} from "./filter";
import { parseSearchParams } from "@/lib/work-items/query/parse";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

describe("workItemFilterToState", () => {
  it("collapses multi-value fields to their first member", () => {
    const wf: WorkItemFilter = {
      projectIds: ["p1", "p2"],
      columnKeys: ["in-progress"],
      assigneeIds: ["u1"],
      labels: ["bug", "urgent"],
      text: "login",
    };
    expect(workItemFilterToState(wf)).toEqual({
      project: "p1",
      status: "in-progress",
      assignee: "u1",
      label: "bug",
      text: "login",
    });
  });

  it("falls back to ANY / empty text for absent fields", () => {
    expect(workItemFilterToState({})).toEqual(EMPTY_DASHBOARD_FILTER);
  });
});

describe("applyStateToFilter", () => {
  it("pins the four bar dimensions and text", () => {
    const state: DashboardFilterState = {
      project: "p1",
      status: "todo",
      assignee: "u9",
      label: "backend",
      text: "  cache  ",
    };
    expect(applyStateToFilter({}, state)).toEqual({
      projectIds: ["p1"],
      columnKeys: ["todo"],
      assigneeIds: ["u9"],
      labels: ["backend"],
      text: "cache",
    });
  });

  it("clears a dimension set to ANY and drops empty text", () => {
    const base: WorkItemFilter = {
      projectIds: ["p1"],
      columnKeys: ["done"],
      assigneeIds: ["u1"],
      labels: ["x"],
      text: "old",
    };
    const cleared = applyStateToFilter(base, EMPTY_DASHBOARD_FILTER);
    expect(cleared.projectIds).toBeUndefined();
    expect(cleared.columnKeys).toBeUndefined();
    expect(cleared.assigneeIds).toBeUndefined();
    expect(cleared.labels).toBeUndefined();
    expect(cleared.text).toBeUndefined();
  });

  it("preserves non-bar fields (type/priority) when overlaying the bar", () => {
    const base: WorkItemFilter = {
      typeIds: ["bug-type"],
      priorities: [Priority.HIGH],
      columnKeys: ["todo"],
    };
    const state: DashboardFilterState = {
      ...EMPTY_DASHBOARD_FILTER,
      assignee: "u1",
      status: "in-review",
    };
    const merged = applyStateToFilter(base, state);
    expect(merged.typeIds).toEqual(["bug-type"]);
    expect(merged.priorities).toEqual([Priority.HIGH]);
    // The bar's status overrides the base's status; assignee is added.
    expect(merged.columnKeys).toEqual(["in-review"]);
    expect(merged.assigneeIds).toEqual(["u1"]);
  });

  it("does not mutate the base filter", () => {
    const base: WorkItemFilter = { projectIds: ["p1"] };
    applyStateToFilter(base, { ...EMPTY_DASHBOARD_FILTER, project: "p2" });
    expect(base.projectIds).toEqual(["p1"]);
  });
});

describe("workItemFilterToSearchParams", () => {
  it("emits repeated params for multi-value fields plus pagination", () => {
    const params = workItemFilterToSearchParams(
      { projectIds: ["a", "b"], labels: ["x"] },
      2,
      50,
    );
    expect(params.getAll("project")).toEqual(["a", "b"]);
    expect(params.getAll("label")).toEqual(["x"]);
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("50");
  });

  it("round-trips through the server's parseSearchParams", () => {
    const wf: WorkItemFilter = {
      projectIds: ["p1", "p2"],
      typeIds: ["t1"],
      columnKeys: ["in-progress"],
      priorities: [Priority.HIGH, Priority.LOW],
      assigneeIds: ["u1", "unassigned"],
      labels: ["bug"],
      text: "search me",
      createdAt: { from: "2026-01-01", to: "2026-02-01" },
      updatedAt: { from: "2026-03-01" },
    };
    const parsed = parseSearchParams(workItemFilterToSearchParams(wf, 1, 25));
    expect(parsed.filter.projectIds).toEqual(["p1", "p2"]);
    expect(parsed.filter.typeIds).toEqual(["t1"]);
    expect(parsed.filter.columnKeys).toEqual(["in-progress"]);
    expect(parsed.filter.priorities).toEqual([Priority.HIGH, Priority.LOW]);
    expect(parsed.filter.assigneeIds).toEqual(["u1", "unassigned"]);
    expect(parsed.filter.labels).toEqual(["bug"]);
    expect(parsed.filter.text).toBe("search me");
    expect(parsed.filter.createdAt).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(parsed.filter.updatedAt).toEqual({ from: "2026-03-01", to: undefined });
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(25);
  });

  it("clamps to page 1 / default page size for an empty filter", () => {
    const parsed = parseSearchParams(workItemFilterToSearchParams({}, 1, 25));
    expect(parsed.filter.projectIds).toBeUndefined();
    expect(parsed.page).toBe(1);
  });
});

describe("groupRowsByStatus", () => {
  const statuses = [
    { key: "todo", name: "To Do", category: "TODO" },
    { key: "in-progress", name: "In Progress", category: "IN_PROGRESS" },
    { key: "done", name: "Done", category: "DONE" },
  ];
  const rows = [
    { id: "1", columnKey: "done" },
    { id: "2", columnKey: "todo" },
    { id: "3", columnKey: "todo" },
    { id: "4", columnKey: "mystery" },
  ];

  it("orders groups by facet order and omits empty lanes", () => {
    const groups = groupRowsByStatus(rows, statuses);
    // "in-progress" has no rows → omitted. "mystery" (no facet) → appended last.
    expect(groups.map((g) => g.key)).toEqual(["todo", "done", "mystery"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["2", "3"]);
    expect(groups.find((g) => g.key === "mystery")?.name).toBe("mystery");
    expect(groups.find((g) => g.key === "mystery")?.category).toBe("UNKNOWN");
  });

  it("returns nothing for no rows", () => {
    expect(groupRowsByStatus([], statuses)).toEqual([]);
  });
});

describe("isEmptyFilterState", () => {
  it("is true for the default and false once a dimension is set", () => {
    expect(isEmptyFilterState(EMPTY_DASHBOARD_FILTER)).toBe(true);
    expect(isEmptyFilterState({ ...EMPTY_DASHBOARD_FILTER, project: "p1" })).toBe(false);
    expect(isEmptyFilterState({ ...EMPTY_DASHBOARD_FILTER, text: "  " })).toBe(true);
    expect(isEmptyFilterState({ ...EMPTY_DASHBOARD_FILTER, status: ANY })).toBe(true);
  });
});
