import { describe, it, expect } from "vitest";
import {
  ANY,
  EMPTY_FILTERS,
  type FilterState,
  toQueryString,
  toWorkItemFilter,
  savedFilterToFilterState,
  serializeIssueFilters,
  parseIssueFilters,
} from "./issues-filters";

/** Feed a serialized query string back through the URL parser. */
function reparse(qs: string): FilterState {
  return parseIssueFilters(new URLSearchParams(qs));
}

describe("issues-filters URL persistence (COSMOS-16)", () => {
  it("serializes a pristine filter set to an empty (clean) query", () => {
    expect(serializeIssueFilters(EMPTY_FILTERS)).toBe("");
  });

  it("parses an empty query back to the empty defaults", () => {
    expect(parseIssueFilters(new URLSearchParams(""))).toEqual(EMPTY_FILTERS);
  });

  it("persists a created-date range across a serialize→parse round-trip", () => {
    const filters: FilterState = {
      ...EMPTY_FILTERS,
      createdFrom: "2026-01-01",
      createdTo: "2026-06-30",
    };
    const qs = serializeIssueFilters(filters);
    expect(qs).toContain("createdFrom=2026-01-01");
    expect(qs).toContain("createdTo=2026-06-30");
    expect(reparse(qs)).toEqual(filters);
  });

  it("persists an open-ended (before / after) updated bound", () => {
    // "after" — only a lower bound.
    const after: FilterState = { ...EMPTY_FILTERS, updatedFrom: "2026-03-01" };
    expect(reparse(serializeIssueFilters(after))).toEqual(after);
    // "before" — only an upper bound.
    const before: FilterState = { ...EMPTY_FILTERS, updatedTo: "2026-03-01" };
    expect(reparse(serializeIssueFilters(before))).toEqual(before);
  });

  it("round-trips time filters COMBINED with facet + text filters (AC: combine correctly)", () => {
    const filters: FilterState = {
      ...EMPTY_FILTERS,
      project: "proj-1",
      priority: "HIGH",
      assignee: "user-9",
      text: "  login bug  ",
      createdFrom: "2026-02-01",
      updatedTo: "2026-02-28",
      watchedByMe: true,
    };
    const restored = reparse(serializeIssueFilters(filters));
    expect(restored).toEqual({
      ...filters,
      // text is trimmed on the way into the URL.
      text: "login bug",
    });
  });

  it("omits inert (ANY / empty) fields from the URL", () => {
    const qs = serializeIssueFilters({ ...EMPTY_FILTERS, status: "in-progress" });
    const params = new URLSearchParams(qs);
    expect(params.get("status")).toBe("in-progress");
    // Untouched facets never appear.
    for (const k of ["project", "type", "priority", "assignee", "label", "text"]) {
      expect(params.has(k)).toBe(false);
    }
    // Pagination is NOT part of the shareable URL — a shared link lands on page 1.
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
  });

  it("keeps the shareable URL free of pagination but the API query carries it", () => {
    const filters: FilterState = { ...EMPTY_FILTERS, createdFrom: "2026-01-01" };
    // The API query string (separate concern) DOES include page + pageSize.
    const api = new URLSearchParams(toQueryString(filters, 3, 50));
    expect(api.get("createdFrom")).toBe("2026-01-01");
    expect(api.get("page")).toBe("3");
    expect(api.get("pageSize")).toBe("50");
  });

  it("honors the watchedByMe toggle round-trip", () => {
    const filters: FilterState = { ...EMPTY_FILTERS, watchedByMe: true };
    expect(serializeIssueFilters(filters)).toBe("watchedByMe=1");
    expect(reparse("watchedByMe=1").watchedByMe).toBe(true);
    expect(reparse("").watchedByMe).toBe(false);
  });

  it("falls back to ANY for a facet param that is present but empty", () => {
    // A hand-crafted `?project=` must not wedge the single-select into "".
    expect(parseIssueFilters(new URLSearchParams("project=")).project).toBe(ANY);
  });
});

describe("issues-filters saved-view mapping preserves time ranges", () => {
  it("round-trips created/updated ranges through the saved-view filter shape", () => {
    const filters: FilterState = {
      ...EMPTY_FILTERS,
      createdFrom: "2026-01-01",
      createdTo: "2026-06-30",
      updatedFrom: "2026-05-01",
    };
    const wf = toWorkItemFilter(filters);
    expect(wf.createdAt).toEqual({ from: "2026-01-01", to: "2026-06-30" });
    expect(wf.updatedAt).toEqual({ from: "2026-05-01", to: undefined });

    const restored = savedFilterToFilterState(wf);
    expect(restored.createdFrom).toBe("2026-01-01");
    expect(restored.createdTo).toBe("2026-06-30");
    expect(restored.updatedFrom).toBe("2026-05-01");
    expect(restored.updatedTo).toBe("");
  });
});
