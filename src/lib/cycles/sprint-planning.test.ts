import { describe, it, expect } from "vitest";
import {
  capacityUnitForSector,
  unitAbbrev,
  unitNoun,
  clampAvailability,
  effectiveCapacity,
  teamCapacity,
  suggestMemberCapacity,
  committedTotal,
  itemSize,
  isOverCommitted,
  DEFAULT_POINTS_CAPACITY,
  DEFAULT_HOURS_CAPACITY,
} from "./sprint-planning";

describe("capacityUnitForSector", () => {
  it("plans software/agile projects in story points", () => {
    expect(capacityUnitForSector("software")).toBe("points");
  });
  it("plans every other sector (and unknown) in hours", () => {
    expect(capacityUnitForSector("aec")).toBe("hours");
    expect(capacityUnitForSector("ops")).toBe("hours");
    expect(capacityUnitForSector(null)).toBe("hours");
    expect(capacityUnitForSector(undefined)).toBe("hours");
  });
});

describe("unit labels", () => {
  it("abbreviates the unit", () => {
    expect(unitAbbrev("points")).toBe("pts");
    expect(unitAbbrev("hours")).toBe("hrs");
  });
  it("spells the unit noun", () => {
    expect(unitNoun("points")).toBe("story points");
    expect(unitNoun("hours")).toBe("hours");
  });
});

describe("clampAvailability", () => {
  it("clamps into 0..100 and defaults non-finite to 100", () => {
    expect(clampAvailability(50)).toBe(50);
    expect(clampAvailability(-10)).toBe(0);
    expect(clampAvailability(140)).toBe(100);
    expect(clampAvailability(NaN)).toBe(100);
  });
});

describe("effectiveCapacity", () => {
  it("scales base by availability percent", () => {
    expect(effectiveCapacity(10, 80)).toBe(8);
    expect(effectiveCapacity(10, 100)).toBe(10);
    expect(effectiveCapacity(10, 0)).toBe(0);
  });
  it("treats a non-positive base as zero", () => {
    expect(effectiveCapacity(-5, 100)).toBe(0);
    expect(effectiveCapacity(NaN, 100)).toBe(0);
  });
  it("rounds to one decimal", () => {
    expect(effectiveCapacity(10, 33)).toBe(3.3);
  });
});

describe("teamCapacity", () => {
  it("sums every member's effective capacity", () => {
    expect(
      teamCapacity([
        { base: 10, availabilityPct: 100 },
        { base: 10, availabilityPct: 50 },
      ]),
    ).toBe(15);
  });
});

describe("suggestMemberCapacity", () => {
  it("uses the standard hours constant for hours-based projects", () => {
    expect(suggestMemberCapacity("hours", [])).toBe(DEFAULT_HOURS_CAPACITY);
    expect(suggestMemberCapacity("hours", [40, 30])).toBe(DEFAULT_HOURS_CAPACITY);
  });
  it("averages the last three sprints of completed points", () => {
    expect(suggestMemberCapacity("points", [10, 8, 6, 100])).toBe(8);
    expect(suggestMemberCapacity("points", [10, 5])).toBe(8);
  });
  it("falls back to a constant with no history", () => {
    expect(suggestMemberCapacity("points", [])).toBe(DEFAULT_POINTS_CAPACITY);
  });
});

describe("itemSize / committedTotal", () => {
  it("sizes points items by story points", () => {
    expect(itemSize({ storyPoints: 5 }, "points")).toBe(5);
    expect(itemSize({ storyPoints: null }, "points")).toBe(0);
    expect(
      committedTotal([{ storyPoints: 5 }, { storyPoints: 3 }], "points"),
    ).toBe(8);
  });
  it("sizes hours items from the original estimate (seconds → hours)", () => {
    expect(itemSize({ originalEstimate: 7200 }, "hours")).toBe(2);
    expect(
      committedTotal(
        [{ originalEstimate: 7200 }, { originalEstimate: 3600 }],
        "hours",
      ),
    ).toBe(3);
  });
});

describe("isOverCommitted", () => {
  it("flags committed scope beyond a positive capacity", () => {
    expect(isOverCommitted(10, 8)).toBe(true);
    expect(isOverCommitted(8, 10)).toBe(false);
    expect(isOverCommitted(8, 8)).toBe(false);
    expect(isOverCommitted(5, 0)).toBe(false);
  });
});
