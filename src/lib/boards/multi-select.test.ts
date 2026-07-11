import { describe, it, expect } from "vitest";
import { selectRange } from "./multi-select";

// Visible cards in on-screen order (e.g. a single "To do" column, top-to-bottom).
const ordered = ["a", "b", "c", "d", "e"];

describe("selectRange — shift-click contiguous range (COSMOS-39)", () => {
  it("selects the inclusive range between anchor and target (downwards)", () => {
    const result = selectRange(ordered, "b", "d", new Set(["b"]));
    expect([...result].sort()).toEqual(["b", "c", "d"]);
  });

  it("selects the same range regardless of click direction (upwards)", () => {
    const down = selectRange(ordered, "b", "d", new Set(["b"]));
    const up = selectRange(ordered, "d", "b", new Set(["d"]));
    expect([...down].sort()).toEqual([...up].sort());
  });

  it("unions the range with an existing selection instead of replacing it", () => {
    // A card from earlier ("a") stays selected while the b→d range is added.
    const result = selectRange(ordered, "b", "d", new Set(["a", "b"]));
    expect([...result].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("adds a single item when there is no anchor yet", () => {
    const result = selectRange(ordered, null, "c", new Set());
    expect([...result]).toEqual(["c"]);
  });

  it("falls back to a single add when the anchor is no longer visible", () => {
    // Anchor scrolled/filtered out of the current view.
    const result = selectRange(ordered, "zzz", "c", new Set());
    expect([...result]).toEqual(["c"]);
  });

  it("falls back to a single add when the target is not visible", () => {
    const result = selectRange(ordered, "b", "zzz", new Set(["b"]));
    expect([...result].sort()).toEqual(["b", "zzz"]);
  });

  it("selects just the one card when anchor === target", () => {
    const result = selectRange(ordered, "c", "c", new Set());
    expect([...result]).toEqual(["c"]);
  });

  it("does not mutate the passed-in selection set", () => {
    const current = new Set(["a"]);
    selectRange(ordered, "b", "d", current);
    expect([...current]).toEqual(["a"]);
  });
});
