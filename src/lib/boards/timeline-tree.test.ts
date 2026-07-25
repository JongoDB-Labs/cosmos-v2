import { describe, it, expect } from "vitest";
import { buildTimelineTree, type TimelineTreeNode } from "./timeline-tree";

// Minimal node factory. `sortOrder` defaults to 0 (the DB default for a
// never-reordered item) so tests opt into a manual rank explicitly.
const node = (
  id: string,
  opts: Partial<TimelineTreeNode> = {},
): TimelineTreeNode => ({
  id,
  parentId: null,
  startDate: null,
  createdAt: "2026-01-01",
  sortOrder: 0,
  ...opts,
});

const ids = (t: { treeRows: { item: { id: string } }[] }) =>
  t.treeRows.map((r) => r.item.id);

describe("buildTimelineTree — sub-item ordering (COSMOS-5)", () => {
  it("orders sub-items by manual sortOrder, independent of ticket order or dates", () => {
    // Parent P with three children given a manual order that is the REVERSE of
    // both their creation order and their start dates.
    const items = [
      node("P", { startDate: "2026-01-01" }),
      node("a", { parentId: "P", startDate: "2026-01-02", sortOrder: 2 }),
      node("b", { parentId: "P", startDate: "2026-01-03", sortOrder: 1 }),
      node("c", { parentId: "P", startDate: "2026-01-04", sortOrder: 0 }),
    ];
    const tree = buildTimelineTree(items, new Set());
    // c (0) → b (1) → a (2), regardless of start date.
    expect(ids(tree)).toEqual(["P", "c", "b", "a"]);
  });

  it("falls back to start date when siblings share the default sortOrder", () => {
    // No child was ever ranked (all sortOrder 0): keep the schedule-first order.
    const items = [
      node("P"),
      node("late", { parentId: "P", startDate: "2026-03-01" }),
      node("early", { parentId: "P", startDate: "2026-01-01" }),
      node("mid", { parentId: "P", startDate: "2026-02-01" }),
    ];
    const tree = buildTimelineTree(items, new Set());
    expect(ids(tree)).toEqual(["P", "early", "mid", "late"]);
  });

  it("keeps roots ordered by start date (not sortOrder)", () => {
    // sortOrder on roots comes from unrelated kanban ranking — the timeline must
    // not reorder top-level items by it.
    const items = [
      node("r1", { startDate: "2026-02-01", sortOrder: 0 }),
      node("r2", { startDate: "2026-01-01", sortOrder: 9 }),
    ];
    const tree = buildTimelineTree(items, new Set());
    expect(ids(tree)).toEqual(["r2", "r1"]);
  });

  it("hides a collapsed parent's subtree but keeps the parent row", () => {
    const items = [
      node("P"),
      node("a", { parentId: "P", sortOrder: 0 }),
      node("b", { parentId: "P", sortOrder: 1 }),
    ];
    const tree = buildTimelineTree(items, new Set(["P"]));
    expect(ids(tree)).toEqual(["P"]);
    expect(tree.parentIds.has("P")).toBe(true);
  });

  it("surfaces an orphaned child (parent out of view) as a root", () => {
    const items = [node("child", { parentId: "missing", startDate: "2026-01-01" })];
    const tree = buildTimelineTree(items, new Set());
    expect(ids(tree)).toEqual(["child"]);
    expect(tree.treeRows[0].depth).toBe(0);
  });

  it("does not hang on a parentId interval", () => {
    // Bad data: x↔y point at each other. Neither is a root (both have an in-view
    // parent), so the walk never starts — it terminates with no rows rather than
    // looping forever. The point of the assertion is that it returns at all.
    const items = [
      node("x", { parentId: "y" }),
      node("y", { parentId: "x" }),
    ];
    const tree = buildTimelineTree(items, new Set());
    expect(tree.treeRows).toHaveLength(0);
  });
});
