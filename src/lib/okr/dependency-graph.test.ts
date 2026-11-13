import { describe, expect, it } from "vitest";
import { wouldCreateCycle } from "./dependency-graph";

const e = (objectiveId: string, dependsOnId: string) => ({ objectiveId, dependsOnId });

describe("wouldCreateCycle", () => {
  it("refuses an objective depending on itself", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true);
  });

  it("refuses the direct reverse of an existing edge", () => {
    expect(wouldCreateCycle([e("a", "b")], "b", "a")).toBe(true);
  });

  it("refuses a loop several steps long", () => {
    const edges = [e("a", "b"), e("b", "c"), e("c", "d")];
    expect(wouldCreateCycle(edges, "d", "a")).toBe(true);
  });

  it("allows a chain, a diamond and an unrelated edge (negative controls)", () => {
    const edges = [e("a", "b"), e("b", "c"), e("a", "d"), e("d", "c")];
    expect(wouldCreateCycle(edges, "c", "x")).toBe(false);
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false);
    expect(wouldCreateCycle(edges, "x", "a")).toBe(false);
  });

  it("terminates on a graph that already holds a loop elsewhere", () => {
    const edges = [e("p", "q"), e("q", "p")];
    expect(wouldCreateCycle(edges, "a", "p")).toBe(false);
  });
});
