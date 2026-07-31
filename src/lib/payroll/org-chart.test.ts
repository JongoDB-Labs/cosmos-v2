import { describe, it, expect } from "vitest";
import { descendantIds, supervisorCandidates } from "./org-chart";

/** a -> b -> c (a is top), plus d with no manager. */
const CHART = [
  { id: "a", managerId: null },
  { id: "b", managerId: "a" },
  { id: "c", managerId: "b" },
  { id: "d", managerId: null },
];

describe("descendantIds", () => {
  it("collects the whole subtree, not just direct reports", () => {
    // c reports to b reports to a — so BOTH are below a. A direct-children-only
    // implementation would return {b} and let a report to c, closing a loop.
    expect(descendantIds(CHART, "a")).toEqual(new Set(["b", "c"]));
  });

  it("a leaf has no descendants", () => {
    expect(descendantIds(CHART, "c")).toEqual(new Set());
  });

  it("terminates on data that already contains a cycle", () => {
    // The server refuses to create this, but a client must never assume the
    // rows it was handed are acyclic — unguarded traversal would hang.
    const cyclic = [
      { id: "x", managerId: "y" },
      { id: "y", managerId: "x" },
    ];
    expect(descendantIds(cyclic, "x")).toEqual(new Set(["x", "y"]));
  });
});

describe("supervisorCandidates", () => {
  it("excludes the employee themselves", () => {
    expect(supervisorCandidates(CHART, "b").map((e) => e.id)).not.toContain("b");
  });

  it("excludes anyone reporting up through them", () => {
    // b may not report to c, because c already reports to b.
    expect(supervisorCandidates(CHART, "b").map((e) => e.id)).toEqual(["a", "d"]);
  });

  it("an unmanaged leaf may report to anyone else", () => {
    expect(supervisorCandidates(CHART, "d").map((e) => e.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
