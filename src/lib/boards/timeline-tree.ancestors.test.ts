// COSMOS-189: what a filter does to a HIERARCHY on the timeline/Gantt.
//
// The decision this encodes (made automatically, see the PR): a non-matching
// row is hidden, but an ancestor that still holds a matching descendant stays —
// the same thing a grouped list does with its group headers. Without it the
// surviving child re-roots to depth 0 and the Gantt stops saying which epic the
// work belongs to, which is the whole job of its indentation.
import { describe, it, expect } from "vitest";
import { withAncestors, buildTimelineTree, type TimelineTreeNode } from "./timeline-tree";

const node = (id: string, parentId: string | null): TimelineTreeNode => ({
  id,
  parentId,
  startDate: "2026-01-01",
  createdAt: "2026-01-01",
  sortOrder: 0,
});

// epic ─ feature ─ story          (a two-level chain, so a partial walk shows)
//      └ other
const EPIC = node("epic", null);
const FEATURE = node("feature", "epic");
const STORY = node("story", "feature");
const OTHER = node("other", "epic");
const LOOSE = node("loose", null);
const ITEMS = [EPIC, FEATURE, STORY, OTHER, LOOSE];

const ids = (rows: TimelineTreeNode[]) => rows.map((r) => r.id);

describe("withAncestors — a filter narrows a hierarchy without flattening it", () => {
  it("keeps the whole ancestor chain of a match that is nested two deep", () => {
    expect(ids(withAncestors(ITEMS, new Set(["story"])))).toEqual([
      "epic",
      "feature",
      "story",
    ]);
  });

  it("drops a sibling branch that holds no match", () => {
    const kept = ids(withAncestors(ITEMS, new Set(["story"])));
    expect(kept).not.toContain("other");
    expect(kept).not.toContain("loose");
  });

  it("keeps a matching root on its own, adding nothing", () => {
    expect(ids(withAncestors(ITEMS, new Set(["loose"])))).toEqual(["loose"]);
  });

  it("returns nothing when nothing matched — an empty board, not the whole board", () => {
    expect(withAncestors(ITEMS, new Set())).toEqual([]);
  });

  it("preserves the input order rather than the order matches were found", () => {
    expect(ids(withAncestors(ITEMS, new Set(["other", "story"])))).toEqual([
      "epic",
      "feature",
      "story",
      "other",
    ]);
  });

  it("stops at the edge of the given set when an ancestor is not in it", () => {
    // `feature` has a parent id, but no `epic` row to walk up to here.
    const partial = [FEATURE, STORY];
    expect(ids(withAncestors(partial, new Set(["story"])))).toEqual(["feature", "story"]);
  });

  it("does not hang on a parentId cycle", () => {
    const a = node("a", "b");
    const b = node("b", "a");
    expect(ids(withAncestors([a, b], new Set(["a"]))).sort()).toEqual(["a", "b"]);
  });

  it("ignores kept ids that are not in the item list", () => {
    expect(withAncestors(ITEMS, new Set(["ghost"]))).toEqual([]);
  });
});

describe("withAncestors + buildTimelineTree — the rows the Gantt actually draws", () => {
  it("draws a filtered-to match at its real depth, under the parents kept for it", () => {
    const { treeRows } = buildTimelineTree(
      withAncestors(ITEMS, new Set(["story"])),
      new Set(),
    );
    expect(treeRows.map((r) => [r.item.id, r.depth])).toEqual([
      ["epic", 0],
      ["feature", 1],
      ["story", 2],
    ]);
  });

  it("would re-root the match to depth 0 if the ancestors were dropped", () => {
    // The pre-COSMOS-189 behaviour, asserted so the difference is on the record
    // rather than implied: filtering to the matches alone flattens the chain.
    const { treeRows } = buildTimelineTree([STORY], new Set());
    expect(treeRows.map((r) => [r.item.id, r.depth])).toEqual([["story", 0]]);
  });
});
