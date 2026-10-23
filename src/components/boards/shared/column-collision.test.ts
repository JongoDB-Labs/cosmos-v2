import { describe, it, expect } from "vitest";
import {
  closestCorners,
  type ClientRect,
  type CollisionDetection,
} from "@dnd-kit/core";
import { columnCollision } from "./column-collision";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): ClientRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

// Two tall columns side by side. "todo" is empty; "doing" holds one card level
// with where the pointer drops into todo's empty middle.
const rects = new Map<string, ClientRect>([
  ["todo", rect(0, 0, 300, 2000)],
  ["doing", rect(320, 0, 300, 2000)],
  ["card-b", rect(330, 950, 280, 100)],
]);
const COLUMNS = new Set(["todo", "doing"]);
const detect = columnCollision((id) => COLUMNS.has(id));

function run(
  pointer: { x: number; y: number } | null,
  fn: CollisionDetection = detect,
) {
  const droppableContainers = [...rects.keys()].map((id) => ({ id }));
  const hits = fn({
    active: { id: "card-a" },
    // The drag overlay, centred under the pointer.
    collisionRect: rect(
      (pointer?.x ?? 150) - 140,
      (pointer?.y ?? 1000) - 50,
      280,
      100,
    ),
    droppableRects: rects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as unknown as Parameters<CollisionDetection>[0]);
  return hits.map((h) => String(h.id));
}

describe("columnCollision", () => {
  it("targets the empty column under the pointer, not a nearby card in the next column", () => {
    expect(run({ x: 150, y: 1000 })[0]).toBe("todo");
  });

  it("prefers the card under the pointer over the column it sits in", () => {
    expect(run({ x: 400, y: 1000 })).toEqual(["card-b"]);
  });

  it("falls back to the closest droppable when the pointer is over none", () => {
    const gap = { x: 310, y: 1000 };
    expect(run(gap)).toEqual(run(gap, closestCorners));
    expect(run(gap).length).toBeGreaterThan(0);
    expect(run(null)).toEqual(run(null, closestCorners));
  });
});
