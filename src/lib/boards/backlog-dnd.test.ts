import { describe, it, expect } from "vitest";
import { resolveDrag, findContainer, BACKLOG_CONTAINER } from "./backlog-dnd";

const containers = {
  [BACKLOG_CONTAINER]: ["a", "b", "c"],
  "cyc-1": ["d", "e"],
  "cyc-2": [], // empty sprint
};

describe("findContainer", () => {
  it("finds an item's container", () => {
    expect(findContainer("a", containers)).toBe(BACKLOG_CONTAINER);
    expect(findContainer("e", containers)).toBe("cyc-1");
  });
  it("recognizes a container id itself", () => {
    expect(findContainer("cyc-2", containers)).toBe("cyc-2");
  });
  it("returns null for an unknown id", () => {
    expect(findContainer("zzz", containers)).toBeNull();
  });
});

describe("resolveDrag — reorder within a container", () => {
  it("reorders within the backlog", () => {
    expect(resolveDrag("a", "c", containers)).toEqual({
      kind: "reorder",
      container: BACKLOG_CONTAINER,
      fromIndex: 0,
      toIndex: 2,
    });
  });
  it("is a no-op dropping on itself", () => {
    expect(resolveDrag("a", "a", containers)).toBeNull();
  });
});

describe("resolveDrag — reassign across containers (the Jira move)", () => {
  it("moves a backlog item into a sprint (onto a row)", () => {
    expect(resolveDrag("a", "d", containers)).toEqual({
      kind: "reassign",
      itemId: "a",
      toIntervalId: "cyc-1",
      toIndex: 0,
    });
  });
  it("moves a backlog item into an EMPTY sprint (onto the container)", () => {
    expect(resolveDrag("a", "cyc-2", containers)).toEqual({
      kind: "reassign",
      itemId: "a",
      toIntervalId: "cyc-2",
      toIndex: 0,
    });
  });
  it("moves a sprint item back to the backlog → clears the interval (toIntervalId null)", () => {
    const move = resolveDrag("d", "b", containers);
    expect(move).toEqual({
      kind: "reassign",
      itemId: "d",
      toIntervalId: null,
      toIndex: 1,
    });
  });
  it("moves between two sprints", () => {
    expect(resolveDrag("d", "cyc-1", { [BACKLOG_CONTAINER]: [], "cyc-1": ["x"], "cyc-3": ["d"] })).toEqual({
      kind: "reassign",
      itemId: "d",
      toIntervalId: "cyc-1",
      toIndex: 1,
    });
  });
});

describe("resolveDrag — guards", () => {
  it("returns null when over is missing", () => {
    expect(resolveDrag("a", null, containers)).toBeNull();
    expect(resolveDrag("a", undefined, containers)).toBeNull();
  });
  it("returns null when the active id is unknown", () => {
    expect(resolveDrag("zzz", "a", containers)).toBeNull();
  });
});
