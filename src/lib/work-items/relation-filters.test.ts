import { describe, it, expect } from "vitest";
import {
  blockedItemIds,
  matchesBlocked,
  milestoneItemIds,
  matchesMilestone,
  presentStoryPoints,
  matchesStoryPoints,
  NO_ESTIMATE,
} from "./relation-filters";

describe("blockedItemIds — direction is the whole game", () => {
  it("marks the TARGET blocked for a BLOCKS link", () => {
    // A BLOCKS B ⇒ B is the one that cannot proceed.
    expect([...blockedItemIds([{ sourceItemId: "A", targetItemId: "B", type: "BLOCKS" }])]).toEqual(["B"]);
  });

  it("marks the SOURCE blocked for a BLOCKED_BY link", () => {
    // A BLOCKED_BY B ⇒ A is the one that cannot proceed. Reading only one
    // spelling would under-report, and a "blocked" view that hides blocked work
    // is worse than no filter at all.
    expect([...blockedItemIds([{ sourceItemId: "A", targetItemId: "B", type: "BLOCKED_BY" }])]).toEqual(["A"]);
  });

  it("ignores link types that are not about blocking", () => {
    const links = [
      { sourceItemId: "A", targetItemId: "B", type: "RELATES" },
      { sourceItemId: "C", targetItemId: "D", type: "DUPLICATES" },
      { sourceItemId: "E", targetItemId: "F", type: "PREDECESSOR" },
    ];
    expect(blockedItemIds(links).size).toBe(0);
  });

  it("counts an item blocked once even by several links", () => {
    const links = [
      { sourceItemId: "A", targetItemId: "B", type: "BLOCKS" },
      { sourceItemId: "C", targetItemId: "B", type: "BLOCKS" },
    ];
    expect([...blockedItemIds(links)]).toEqual(["B"]);
  });
});

describe("matchesBlocked", () => {
  const blocked = new Set(["B"]);
  it("is inert on 'any'", () => {
    expect(matchesBlocked("B", "any", blocked)).toBe(true);
    expect(matchesBlocked("Z", "any", blocked)).toBe(true);
  });
  it("finds blocked work", () => {
    expect(matchesBlocked("B", "blocked", blocked)).toBe(true);
    expect(matchesBlocked("Z", "blocked", blocked)).toBe(false);
  });
  it("finds work that can proceed", () => {
    expect(matchesBlocked("Z", "unblocked", blocked)).toBe(true);
    expect(matchesBlocked("B", "unblocked", blocked)).toBe(false);
  });
});

describe("milestone membership", () => {
  const map = milestoneItemIds([
    { id: "m1", title: "Alpha", links: [{ workItemId: "i1" }, { workItemId: "i2" }] },
    { id: "m2", title: "Beta", links: [{ workItemId: "i2" }] },
    { id: "m3", title: "Empty", links: [] },
  ]);

  it("is inert when no milestone is chosen", () => {
    expect(matchesMilestone("i1", null, map)).toBe(true);
  });

  it("matches an item linked to it", () => {
    expect(matchesMilestone("i1", "m1", map)).toBe(true);
  });

  it("does not match an item linked elsewhere", () => {
    expect(matchesMilestone("i1", "m2", map)).toBe(false);
  });

  it("lets one item serve several milestones", () => {
    expect(matchesMilestone("i2", "m1", map)).toBe(true);
    expect(matchesMilestone("i2", "m2", map)).toBe(true);
  });

  it("matches nothing for a milestone with no linked work", () => {
    expect(matchesMilestone("i1", "m3", map)).toBe(false);
  });

  it("tolerates a milestone whose links were not loaded", () => {
    const m = milestoneItemIds([{ id: "m9", title: "X", links: null }]);
    expect(matchesMilestone("i1", "m9", m)).toBe(false);
  });
});

describe("story points", () => {
  it("offers the values on the board, numerically ordered", () => {
    // String sort would put 13 before 2.
    expect(presentStoryPoints([{ storyPoints: 13 }, { storyPoints: 2 }, { storyPoints: 5 }]))
      .toEqual(["2", "5", "13"]);
  });

  it("adds an explicit 'no estimate' option only when some item lacks one", () => {
    expect(presentStoryPoints([{ storyPoints: 3 }])).toEqual(["3"]);
    expect(presentStoryPoints([{ storyPoints: 3 }, { storyPoints: null }])).toEqual(["3", NO_ESTIMATE]);
  });

  it("deduplicates", () => {
    expect(presentStoryPoints([{ storyPoints: 3 }, { storyPoints: 3 }])).toEqual(["3"]);
  });

  it("is inert when nothing is selected", () => {
    expect(matchesStoryPoints(3, [])).toBe(true);
    expect(matchesStoryPoints(null, [])).toBe(true);
  });

  it("matches a selected value", () => {
    expect(matchesStoryPoints(3, ["3", "5"])).toBe(true);
    expect(matchesStoryPoints(8, ["3", "5"])).toBe(false);
  });

  it("finds unestimated work only via the explicit option", () => {
    // "Unestimated" is a question teams ask constantly and no comparator
    // expresses it — which is why points are a multi-select and not `> 5`.
    expect(matchesStoryPoints(null, [NO_ESTIMATE])).toBe(true);
    expect(matchesStoryPoints(null, ["3"])).toBe(false);
  });

  it("does not confuse 0 points with no estimate", () => {
    // 0 is a real, deliberate estimate; `== null` rather than falsiness.
    expect(matchesStoryPoints(0, ["0"])).toBe(true);
    expect(matchesStoryPoints(0, [NO_ESTIMATE])).toBe(false);
    expect(presentStoryPoints([{ storyPoints: 0 }])).toEqual(["0"]);
  });
});
