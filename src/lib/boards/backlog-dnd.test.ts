import { describe, it, expect } from "vitest";
import {
  resolveDrag,
  findContainer,
  buildIntervalSections,
  BACKLOG_CONTAINER,
} from "./backlog-dnd";

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

// --- buildIntervalSections ---------------------------------------------------
// Sections used to be derived from the ITEMS alone, so a sprint holding nothing
// rendered no section — and with no section there is no droppable node, which
// is why an item could never be dragged into a brand-new sprint. The drag layer
// above always supported it (see the empty "cyc-2" container in the fixture);
// the destination simply was not on screen.
const iv = (
  id: string,
  status: "ACTIVE" | "PLANNED" | "COMPLETED",
  startDate: string,
) => ({ id, status, startDate });

const wi = (id: string, intervalId: string | null, sortOrder = 0) => ({
  id,
  intervalId,
  sortOrder,
});

const byRank = (a: { sortOrder: number }, b: { sortOrder: number }) =>
  a.sortOrder - b.sortOrder;

describe("buildIntervalSections", () => {
  it("gives an EMPTY plannable sprint a section, so it can be dropped into", () => {
    const sections = buildIntervalSections(
      [wi("w1", null)],
      [iv("s1", "PLANNED", "2026-01-01")],
      byRank,
    );
    expect(sections.map((s) => s.intervalId)).toEqual(["s1"]);
    expect(sections[0].items).toEqual([]);
  });

  it("orders ACTIVE before PLANNED, then by start date", () => {
    const sections = buildIntervalSections(
      [],
      [
        iv("later", "PLANNED", "2026-03-01"),
        iv("sooner", "PLANNED", "2026-02-01"),
        iv("live", "ACTIVE", "2026-09-01"),
      ],
      byRank,
    );
    expect(sections.map((s) => s.intervalId)).toEqual(["live", "sooner", "later"]);
  });

  it("omits an empty COMPLETED sprint but keeps one that still holds items", () => {
    const sections = buildIntervalSections(
      [wi("w1", "done-full")],
      [iv("done-empty", "COMPLETED", "2025-01-01"), iv("done-full", "COMPLETED", "2025-02-01")],
      byRank,
    );
    expect(sections.map((s) => s.intervalId)).toEqual(["done-full"]);
  });

  it("keeps items whose interval is unknown, rather than dropping them", () => {
    // An item pointing at an interval the project list doesn't include (stale
    // cache, or an interval the user can't read) must still be reachable.
    const sections = buildIntervalSections([wi("w1", "ghost")], [], byRank);
    expect(sections).toHaveLength(1);
    expect(sections[0].interval).toBeNull();
    expect(sections[0].items.map((i) => i.id)).toEqual(["w1"]);
  });

  it("ranks items inside a section", () => {
    const sections = buildIntervalSections(
      [wi("b", "s1", 2), wi("a", "s1", 1)],
      [iv("s1", "ACTIVE", "2026-01-01")],
      byRank,
    );
    expect(sections[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
