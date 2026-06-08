import { describe, expect, it } from "vitest";
import { Priority } from "@prisma/client";
import { parseSearchParams, workItemQuerySchema } from "./parse";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./filter";

function sp(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseSearchParams — multi-value", () => {
  it("repeated keys → array", () => {
    const { filter } = parseSearchParams(sp("project=a&project=b"));
    expect(filter.projectIds).toEqual(["a", "b"]);
  });
  it("CSV → array", () => {
    const { filter } = parseSearchParams(sp("type=t1,t2,t3"));
    expect(filter.typeIds).toEqual(["t1", "t2", "t3"]);
  });
  it("absent → undefined", () => {
    const { filter } = parseSearchParams(sp(""));
    expect(filter.projectIds).toBeUndefined();
    expect(filter.text).toBeUndefined();
  });
});

describe("parseSearchParams — priority validation", () => {
  it("keeps only valid Priority values", () => {
    const { filter } = parseSearchParams(sp("priority=HIGH&priority=BOGUS&priority=LOW"));
    expect(filter.priorities).toEqual([Priority.HIGH, Priority.LOW]);
  });
  it("all-invalid → undefined", () => {
    const { filter } = parseSearchParams(sp("priority=nope"));
    expect(filter.priorities).toBeUndefined();
  });
});

describe("parseSearchParams — parent", () => {
  it("has_parent", () => {
    expect(parseSearchParams(sp("parent=has_parent")).filter.parent).toEqual({
      mode: "has_parent",
    });
  });
  it("no_parent", () => {
    expect(parseSearchParams(sp("parent=no_parent")).filter.parent).toEqual({
      mode: "no_parent",
    });
  });
  it("specific parentIds → is", () => {
    expect(parseSearchParams(sp("parentId=p1&parentId=p2")).filter.parent).toEqual({
      mode: "is",
      parentIds: ["p1", "p2"],
    });
  });
});

describe("parseSearchParams — date ranges", () => {
  it("start range", () => {
    const { filter } = parseSearchParams(sp("startFrom=2026-01-01&startTo=2026-02-01"));
    expect(filter.startDate).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });
  it("due from only", () => {
    const { filter } = parseSearchParams(sp("dueFrom=2026-06-01"));
    expect(filter.dueDate).toEqual({ from: "2026-06-01", to: undefined });
  });
});

describe("parseSearchParams — pagination + sort", () => {
  it("defaults", () => {
    const r = parseSearchParams(sp(""));
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(r.sort).toBeUndefined();
  });
  it("clamps pageSize to MAX", () => {
    expect(parseSearchParams(sp("pageSize=10000")).pageSize).toBe(MAX_PAGE_SIZE);
  });
  it("floors page at 1", () => {
    expect(parseSearchParams(sp("page=0")).page).toBe(1);
    expect(parseSearchParams(sp("page=-5")).page).toBe(1);
  });
  it("valid sort field is parsed", () => {
    expect(parseSearchParams(sp("sortField=dueDate&sortDir=asc")).sort).toEqual({
      field: "dueDate",
      direction: "asc",
    });
  });
  it("invalid sort field is ignored", () => {
    expect(parseSearchParams(sp("sortField=bogus")).sort).toBeUndefined();
  });
});

describe("workItemQuerySchema — POST body", () => {
  it("applies defaults for an empty body", () => {
    const parsed = workItemQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parsed.filter).toEqual({});
  });
  it("rejects pageSize over the cap", () => {
    expect(() => workItemQuerySchema.parse({ pageSize: 1000 })).toThrow();
  });
  it("accepts a full filter", () => {
    const parsed = workItemQuerySchema.parse({
      filter: {
        projectIds: ["a"],
        priorities: ["HIGH"],
        parent: { mode: "is", parentIds: ["x"] },
        text: "bug",
      },
      sort: { field: "priority", direction: "asc" },
      page: 2,
      pageSize: 50,
    });
    expect(parsed.filter.priorities).toEqual([Priority.HIGH]);
    expect(parsed.filter.parent).toEqual({ mode: "is", parentIds: ["x"] });
    expect(parsed.sort).toEqual({ field: "priority", direction: "asc" });
  });
});
