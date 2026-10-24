import { describe, it, expect } from "vitest";
import { ANY_NODE, layoutWorkflow, NODE_H, NODE_W } from "../layered-layout";

const nodes = [
  { id: ANY_NODE, category: null },
  { id: "todo", category: "TODO" },
  { id: "doing", category: "IN_PROGRESS" },
  { id: "review", category: "IN_PROGRESS" },
  { id: "done", category: "DONE" },
  { id: "wontfix", category: "DONE" },
  { id: "cancelled", category: "CANCELLED" },
];
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });

describe("layoutWorkflow", () => {
  it("puts the any node first, then one band per category, left to right", async () => {
    const at = await layoutWorkflow(nodes, [edge("todo", "doing"), edge("doing", "review"), edge("review", "done"), edge(ANY_NODE, "cancelled")]);
    const col = (id: string) => at[id].x / (NODE_W + 90);
    expect([ANY_NODE, "todo", "doing", "review", "done", "wontfix", "cancelled"].map(col)).toEqual([0, 1, 2, 2, 3, 3, 4]);
    // Nothing overlaps.
    const spots = new Set(Object.values(at).map((p) => `${p.x}:${p.y}`));
    expect(spots.size).toBe(nodes.length);
  });

  it("orders a band by where its incoming moves come from, so edges don't cross", async () => {
    // y is listed second but fed by a (the first To do row), so it moves above x, fed by b.
    const at = await layoutWorkflow(
      [{ id: "a", category: "TODO" }, { id: "b", category: "TODO" }, { id: "x", category: "IN_PROGRESS" }, { id: "y", category: "IN_PROGRESS" }],
      [edge("b", "x"), edge("a", "y")],
    );
    expect(at.y.y).toBeLessThan(at.x.y);
    expect([at.a.y, at.b.y]).toEqual([0, NODE_H + 40]);
  });

  it("lays out a lone category without empty bands before it", async () => {
    const at = await layoutWorkflow([{ id: "done", category: "DONE" }], []);
    expect(at.done).toEqual({ x: 0, y: 0 });
  });
});
