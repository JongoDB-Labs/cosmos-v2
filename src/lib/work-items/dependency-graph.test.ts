import { describe, it, expect } from "vitest";
import { LinkType } from "@prisma/client";
import {
  directedDependencyEdge,
  wouldCreateDependencyCycle,
  type DirectedEdge,
} from "./dependency-graph";

describe("directedDependencyEdge", () => {
  it("points source → target for BLOCKS and PREDECESSOR (target depends on source)", () => {
    expect(directedDependencyEdge(LinkType.BLOCKS, "A", "B")).toEqual({ from: "A", to: "B" });
    expect(directedDependencyEdge(LinkType.PREDECESSOR, "A", "B")).toEqual({ from: "A", to: "B" });
  });

  it("points target → source for BLOCKED_BY and SUCCESSOR (source depends on target)", () => {
    expect(directedDependencyEdge(LinkType.BLOCKED_BY, "A", "B")).toEqual({ from: "B", to: "A" });
    expect(directedDependencyEdge(LinkType.SUCCESSOR, "A", "B")).toEqual({ from: "B", to: "A" });
  });

  it("returns null for undirected relationships that can never form a dependency cycle", () => {
    expect(directedDependencyEdge(LinkType.RELATES, "A", "B")).toBeNull();
    expect(directedDependencyEdge(LinkType.DUPLICATES, "A", "B")).toBeNull();
    expect(directedDependencyEdge(LinkType.CLONES, "A", "B")).toBeNull();
  });
});

describe("wouldCreateDependencyCycle", () => {
  const edge = (from: string, to: string): DirectedEdge => ({ from, to });

  it("allows the very first edge in an empty graph", () => {
    expect(wouldCreateDependencyCycle([], edge("A", "B"))).toBe(false);
  });

  it("rejects a self-edge outright", () => {
    expect(wouldCreateDependencyCycle([], edge("A", "A"))).toBe(true);
  });

  it("rejects a direct 2-cycle (A→B already exists, adding B→A closes it)", () => {
    // A blocks B, then someone tries to make B block A — a mutual deadlock.
    expect(wouldCreateDependencyCycle([edge("A", "B")], edge("B", "A"))).toBe(true);
  });

  it("rejects a contradictory relationship that normalizes to the reverse edge", () => {
    // A BLOCKS B → edge A→B. A BLOCKED_BY B → edge B→A. The second is a cycle.
    const existing = directedDependencyEdge(LinkType.BLOCKS, "A", "B")!;
    const contradiction = directedDependencyEdge(LinkType.BLOCKED_BY, "A", "B")!;
    expect(wouldCreateDependencyCycle([existing], contradiction)).toBe(true);
  });

  it("rejects a transitive cycle across multiple hops", () => {
    // A→B→C already; adding C→A closes the loop.
    const chain = [edge("A", "B"), edge("B", "C")];
    expect(wouldCreateDependencyCycle(chain, edge("C", "A"))).toBe(true);
  });

  it("allows a non-cyclic edge into an existing chain", () => {
    // A→B→C; adding A→C (a shortcut) keeps the DAG acyclic.
    const chain = [edge("A", "B"), edge("B", "C")];
    expect(wouldCreateDependencyCycle(chain, edge("A", "C"))).toBe(false);
  });

  it("allows an edge that shares a node but points away from the chain", () => {
    // A→B exists; A→C introduces a fresh branch, no cycle.
    expect(wouldCreateDependencyCycle([edge("A", "B")], edge("A", "C"))).toBe(false);
  });

  it("terminates and still detects a cycle even when the existing graph is already cyclic", () => {
    // Legacy/imported data could already contain a loop (B↔C). The guard must
    // not hang on it, and must still catch a NEW edge that closes another loop.
    const cyclic = [edge("A", "B"), edge("B", "C"), edge("C", "B")];
    // D→A points into the graph but nothing leads back to D — no new cycle.
    expect(wouldCreateDependencyCycle(cyclic, edge("D", "A"))).toBe(false);
    // C→A closes A→B→C→A despite the pre-existing B↔C loop.
    expect(wouldCreateDependencyCycle(cyclic, edge("C", "A"))).toBe(true);
  });
});
