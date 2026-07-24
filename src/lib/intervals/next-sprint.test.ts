import { describe, it, expect } from "vitest";
import { nextSprintName, computeNextSprintDefaults } from "./next-sprint";

describe("nextSprintName", () => {
  it("increments a trailing number", () => {
    expect(nextSprintName("Sprint 1")).toBe("Sprint 2");
    expect(nextSprintName("Sprint 12")).toBe("Sprint 13");
  });

  it("increments the LAST number in a compound name", () => {
    expect(nextSprintName("Increment 1 · Sprint 3")).toBe("Increment 1 · Sprint 4");
  });

  it("preserves zero-padding width", () => {
    expect(nextSprintName("Sprint 09")).toBe("Sprint 10");
    expect(nextSprintName("Sprint 099")).toBe("Sprint 100");
  });

  it("appends ' 2' when there is no number", () => {
    expect(nextSprintName("Hardening")).toBe("Hardening 2");
  });

  it("trims and handles an empty name", () => {
    expect(nextSprintName("  Sprint 1  ")).toBe("Sprint 2");
    expect(nextSprintName("   ")).toBe("Sprint 2");
  });
});

describe("computeNextSprintDefaults", () => {
  it("keeps the same duration starting the day after the previous end", () => {
    // Two-week Sprint 1: Jul 1 → Jul 14 (13-day span).
    const next = computeNextSprintDefaults({
      name: "Sprint 1",
      startDate: "2026-07-01",
      endDate: "2026-07-14",
    });
    expect(next.name).toBe("Sprint 2");
    expect(next.startDate).toBe("2026-07-15");
    expect(next.endDate).toBe("2026-07-28");
  });

  it("accepts ISO datetime strings and is timezone-safe", () => {
    const next = computeNextSprintDefaults({
      name: "Sprint 5",
      startDate: "2026-01-05T00:00:00.000Z",
      endDate: "2026-01-18T00:00:00.000Z",
    });
    expect(next.name).toBe("Sprint 6");
    expect(next.startDate).toBe("2026-01-19");
    expect(next.endDate).toBe("2026-02-01");
  });

  it("crosses a month boundary correctly for a one-week sprint", () => {
    const next = computeNextSprintDefaults({
      name: "Sprint 30",
      startDate: "2026-01-26",
      endDate: "2026-02-01",
    });
    expect(next.startDate).toBe("2026-02-02");
    expect(next.endDate).toBe("2026-02-08");
  });
});
