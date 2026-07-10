import { describe, it, expect } from "vitest";
import { groupStatusesByProject, type ColumnFacetRow } from "./status-facets";

const col = (
  projectId: string,
  key: string,
  name: string,
  category = "TODO",
): ColumnFacetRow => ({ key, name, category, board: { projectId } });

describe("groupStatusesByProject", () => {
  it("keys each project to only its OWN board lanes", () => {
    // Two projects with DIFFERENT lanes. The inline status editor must never
    // offer project B's 'in_review' lane for a project-A item — that would be
    // an invalid transition the work-item PUT can't reject (COSMOS-30).
    const grouped = groupStatusesByProject([
      col("A", "todo", "To Do"),
      col("A", "done", "Done", "DONE"),
      col("B", "todo", "Backlog"),
      col("B", "in_review", "In Review", "IN_PROGRESS"),
    ]);

    expect(grouped.A.map((s) => s.key)).toEqual(["todo", "done"]);
    expect(grouped.B.map((s) => s.key)).toEqual(["todo", "in_review"]);
    // No cross-contamination between projects.
    expect(grouped.A.some((s) => s.key === "in_review")).toBe(false);
  });

  it("dedupes a key that recurs across a project's boards, keeping the first (lowest sortOrder) label", () => {
    // Rows arrive pre-ordered by sortOrder; a project with two boards can carry
    // the same key twice — the first-seen name/category wins.
    const grouped = groupStatusesByProject([
      col("A", "todo", "To Do", "TODO"),
      col("A", "todo", "Backlog", "TODO"),
      col("A", "done", "Done", "DONE"),
    ]);

    expect(grouped.A).toEqual([
      { key: "todo", name: "To Do", category: "TODO" },
      { key: "done", name: "Done", category: "DONE" },
    ]);
  });

  it("carries each lane's display name and category through", () => {
    const grouped = groupStatusesByProject([
      col("A", "in_progress", "In Progress", "IN_PROGRESS"),
    ]);
    expect(grouped.A[0]).toEqual({
      key: "in_progress",
      name: "In Progress",
      category: "IN_PROGRESS",
    });
  });

  it("returns an empty map for no columns", () => {
    expect(groupStatusesByProject([])).toEqual({});
  });
});
