import { describe, it, expect } from "vitest";
import { matchesLabelFilter, presentLabels } from "./label-filter";

// Labels are the first board filter where the ITEM side is multi-valued: an item
// has many labels but exactly one type, one priority, one interval. So the
// matching rule is an intersection, not a membership test, and that difference
// is what these pin down.

describe("matchesLabelFilter", () => {
  it("is inert when nothing is selected", () => {
    expect(matchesLabelFilter(["blocked"], [])).toBe(true);
    expect(matchesLabelFilter([], [])).toBe(true);
    expect(matchesLabelFilter(null, [])).toBe(true);
  });

  it("matches an item carrying the selected label", () => {
    expect(matchesLabelFilter(["blocked"], ["blocked"])).toBe(true);
  });

  it("does not match an item without it", () => {
    expect(matchesLabelFilter(["ui"], ["blocked"])).toBe(false);
  });

  it("matches on ANY selected label, not all of them", () => {
    // OR, like Type and Priority: picking more labels widens the result.
    // Requiring both is a different question and would need its own control.
    expect(matchesLabelFilter(["ui"], ["blocked", "ui"])).toBe(true);
  });

  it("matches when the item has extra labels beyond the selection", () => {
    expect(matchesLabelFilter(["ui", "blocked", "perf"], ["blocked"])).toBe(true);
  });

  it("excludes an unlabelled item once a label is selected", () => {
    expect(matchesLabelFilter([], ["blocked"])).toBe(false);
    expect(matchesLabelFilter(null, ["blocked"])).toBe(false);
    expect(matchesLabelFilter(undefined, ["blocked"])).toBe(false);
  });
});

describe("presentLabels", () => {
  it("collects every label on the board, deduplicated and sorted", () => {
    expect(
      presentLabels([{ tags: ["ui", "blocked"] }, { tags: ["blocked", "api"] }]),
    ).toEqual(["api", "blocked", "ui"]);
  });

  it("ignores items with no labels", () => {
    expect(presentLabels([{ tags: [] }, { tags: null }, {}, { tags: ["ui"] }])).toEqual(["ui"]);
  });

  it("drops empty strings rather than offering a blank menu entry", () => {
    expect(presentLabels([{ tags: ["", "ui"] }])).toEqual(["ui"]);
  });

  it("sorts the way a reader expects, not by code point", () => {
    expect(presentLabels([{ tags: ["zebra", "Ávila"] }])).toEqual(["Ávila", "zebra"]);
  });

  it("is empty for an empty board, so the control can hide itself", () => {
    expect(presentLabels([])).toEqual([]);
  });
});
