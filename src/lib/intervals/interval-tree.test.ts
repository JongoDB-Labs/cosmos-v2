import { describe, it, expect } from "vitest";
import {
  buildIntervalTree,
  intervalChildrenById,
  type TreeInterval,
} from "./interval-tree";

// The intervals screen listed everything newest-first, because the API returns
// `orderBy: { number: "desc" }` and the UI applied no ordering of its own —
// so Sprint 5 sat above Sprint 1 and a Program Increment's sprints read
// backwards. Ordering is a presentation decision, so it lives here rather than
// in the API, which five other surfaces (pickers, roadmap, table) also consume.

const PI = "PROGRAM_INCREMENT";

function iv(over: Partial<TreeInterval> & { id: string; number: number }): TreeInterval {
  return { intervalKind: "SPRINT", parentId: null, ...over };
}

describe("buildIntervalTree — ordering", () => {
  it("orders top-level intervals ascending, not newest-first", () => {
    const out = buildIntervalTree([iv({ id: "c", number: 3 }), iv({ id: "a", number: 1 }), iv({ id: "b", number: 2 })]);
    expect(out.standalone.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("orders a PI's sprints ascending too", () => {
    const out = buildIntervalTree([
      iv({ id: "pi", number: 1, intervalKind: PI }),
      iv({ id: "s3", number: 3, parentId: "pi" }),
      iv({ id: "s1", number: 1, parentId: "pi" }),
      iv({ id: "s2", number: 2, parentId: "pi" }),
    ]);
    expect(out.pis[0].children.map((c) => c.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("orders the PIs themselves ascending", () => {
    const out = buildIntervalTree([
      iv({ id: "pi2", number: 2, intervalKind: PI }),
      iv({ id: "pi1", number: 1, intervalKind: PI }),
    ]);
    expect(out.pis.map((p) => p.interval.id)).toEqual(["pi1", "pi2"]);
  });

  it("breaks ties on id so the order is stable, not dependent on input order", () => {
    const a = buildIntervalTree([iv({ id: "x", number: 1 }), iv({ id: "b", number: 1 })]);
    const b = buildIntervalTree([iv({ id: "b", number: 1 }), iv({ id: "x", number: 1 })]);
    expect(a.standalone.map((i) => i.id)).toEqual(b.standalone.map((i) => i.id));
  });
});

describe("buildIntervalTree — grouping", () => {
  it("puts a PI's children under it and keeps them out of standalone", () => {
    const out = buildIntervalTree([
      iv({ id: "pi", number: 1, intervalKind: PI }),
      iv({ id: "s1", number: 1, parentId: "pi" }),
      iv({ id: "loose", number: 9 }),
    ]);
    expect(out.pis).toHaveLength(1);
    expect(out.pis[0].children.map((c) => c.id)).toEqual(["s1"]);
    expect(out.standalone.map((i) => i.id)).toEqual(["loose"]);
  });

  it("keeps a PI with no sprints, so it can still be expanded and filled", () => {
    const out = buildIntervalTree([iv({ id: "pi", number: 1, intervalKind: PI })]);
    expect(out.pis[0].children).toEqual([]);
  });

  it("does not list a PI in standalone", () => {
    const out = buildIntervalTree([iv({ id: "pi", number: 1, intervalKind: PI })]);
    expect(out.standalone).toEqual([]);
  });

  it("rescues a sprint whose parent PI is missing instead of hiding it", () => {
    // parentId survives a PI delete (SetNull is on the FK, but a stale client
    // cache can still hold one). Dropping such a sprint from both buckets would
    // make it invisible with no way to fix it.
    const out = buildIntervalTree([iv({ id: "orphan", number: 1, parentId: "gone" })]);
    expect(out.standalone.map((i) => i.id)).toEqual(["orphan"]);
  });

  it("does not nest a PI under another PI", () => {
    // The model allows parentId on anything; the UI only nests one level.
    const out = buildIntervalTree([
      iv({ id: "pi1", number: 1, intervalKind: PI }),
      iv({ id: "pi2", number: 2, intervalKind: PI, parentId: "pi1" }),
    ]);
    expect(out.pis.map((p) => p.interval.id)).toEqual(["pi1", "pi2"]);
    expect(out.pis[0].children).toEqual([]);
  });

  it("tolerates an empty list", () => {
    expect(buildIntervalTree([])).toEqual({ pis: [], standalone: [] });
  });
});

/**
 * The lookup a board's filter needs to make "show me this PI" mean the whole
 * PI (3d90c48e). A filter holding a PI id matches only the work planned into
 * the PI itself unless it is widened to that PI's sprints.
 */
describe("intervalChildrenById", () => {
  it("maps a PI to the ids of its sprints", () => {
    const m = intervalChildrenById([
      iv({ id: "pi-1", number: 1, intervalKind: PI }),
      iv({ id: "s-1", number: 1, parentId: "pi-1" }),
      iv({ id: "s-2", number: 2, parentId: "pi-1" }),
    ]);
    expect(m.get("pi-1")).toEqual(new Set(["s-1", "s-2"]));
  });

  it("keeps two PIs apart rather than pooling every sprint", () => {
    const m = intervalChildrenById([
      iv({ id: "pi-1", number: 1, intervalKind: PI }),
      iv({ id: "pi-2", number: 2, intervalKind: PI }),
      iv({ id: "s-1", number: 1, parentId: "pi-1" }),
      iv({ id: "s-9", number: 9, parentId: "pi-2" }),
    ]);
    expect(m.get("pi-1")).toEqual(new Set(["s-1"]));
    expect(m.get("pi-2")).toEqual(new Set(["s-9"]));
  });

  it("gives an empty PI an entry, so selecting it means 'no work' not 'no filter'", () => {
    const m = intervalChildrenById([iv({ id: "pi-1", number: 1, intervalKind: PI })]);
    // Present, and empty — a missing entry would fall through to the exact
    // match and is indistinguishable from an unknown id.
    expect(m.has("pi-1")).toBe(true);
    expect(m.get("pi-1")).toEqual(new Set());
  });

  it("has no entry for a sprint, which is matched exactly and never rolled up", () => {
    const m = intervalChildrenById([
      iv({ id: "pi-1", number: 1, intervalKind: PI }),
      iv({ id: "s-1", number: 1, parentId: "pi-1" }),
    ]);
    expect(m.has("s-1")).toBe(false);
  });

  it("tolerates an empty list", () => {
    expect(intervalChildrenById([]).size).toBe(0);
  });
});
