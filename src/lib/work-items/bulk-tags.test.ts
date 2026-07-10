import { describe, it, expect } from "vitest";
import { planTagAddition, type TagRowInfo } from "./bulk-tags";

const info = (projectId: string, tags: string[]): TagRowInfo => ({ projectId, tags });

describe("planTagAddition", () => {
  it("groups current-page rows by (project, tag-set) with the tag appended", () => {
    const currentPage = new Map<string, TagRowInfo>([
      ["a", info("p1", [])],
      ["b", info("p1", [])],
      ["c", info("p2", ["x"])],
    ]);
    const groups = planTagAddition(["a", "b", "c"], currentPage, null, "urgent");

    // a+b share (p1, no tags) → one group; c is a different project + tag-set.
    expect(groups).toHaveLength(2);
    const p1 = groups.find((g) => g.projectId === "p1" && g.ids.length === 2)!;
    expect(p1.ids.sort()).toEqual(["a", "b"]);
    expect(p1.tags).toEqual(["urgent"]);
    const p2 = groups.find((g) => g.projectId === "p2")!;
    expect(p2.ids).toEqual(["c"]);
    expect(p2.tags.sort()).toEqual(["urgent", "x"]);
  });

  it("includes OFF-PAGE selections from the snapshot (the reported bug)", () => {
    // "Select all matching" selects ids beyond the visible page; only page-1 is
    // in `currentPage`. The pre-fix code iterated the current page only, so the
    // off-page ids were silently dropped from the tag write.
    const currentPage = new Map<string, TagRowInfo>([["a", info("p1", [])]]);
    const offPage = new Map<string, TagRowInfo>([
      ["a", info("p1", [])],
      ["b", info("p1", [])],
      ["c", info("p2", [])],
    ]);
    const groups = planTagAddition(["a", "b", "c"], currentPage, offPage, "q3");

    const tagged = groups.flatMap((g) => g.ids).sort();
    expect(tagged).toEqual(["a", "b", "c"]);
    expect(groups.every((g) => g.tags.includes("q3"))).toBe(true);
  });

  it("prefers the current-page tag-set over a stale snapshot", () => {
    // Row `a` gained a tag since the snapshot was captured; use the fresh set.
    const currentPage = new Map<string, TagRowInfo>([["a", info("p1", ["fresh"])]]);
    const offPage = new Map<string, TagRowInfo>([["a", info("p1", [])]]);
    const groups = planTagAddition(["a"], currentPage, offPage, "new");

    expect(groups).toHaveLength(1);
    expect(groups[0].tags.sort()).toEqual(["fresh", "new"]);
  });

  it("skips items that already carry the tag", () => {
    const currentPage = new Map<string, TagRowInfo>([
      ["a", info("p1", ["done"])],
      ["b", info("p1", [])],
    ]);
    const groups = planTagAddition(["a", "b"], currentPage, null, "done");

    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual(["b"]);
  });

  it("ignores unresolvable ids and blank tags", () => {
    const currentPage = new Map<string, TagRowInfo>([["a", info("p1", [])]]);
    expect(planTagAddition(["ghost"], currentPage, null, "x")).toEqual([]);
    expect(planTagAddition(["a"], currentPage, null, "   ")).toEqual([]);
  });
});
