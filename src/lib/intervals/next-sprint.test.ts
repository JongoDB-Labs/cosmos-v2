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

/**
 * Completing a sprint offers to plan the next one, pre-filled with the
 * incremented name. Teams routinely plan a sprint or two AHEAD, so "Sprint 2"
 * frequently already exists by the time "Sprint 1" is completed — and nothing
 * checked. Accepting the pre-fill produced a SECOND "Sprint 2". The interval
 * `number` stayed unique (it is `max + 1`), so it read as a display bug rather
 * than two rows, which is what made it confusing to report.
 */
describe("nextSprintName — skipping names already in use", () => {
  it("skips a name that is already taken", () => {
    expect(nextSprintName("Sprint 1", ["Sprint 2"])).toBe("Sprint 3");
  });

  it("keeps skipping over a run of taken names", () => {
    expect(nextSprintName("Sprint 1", ["Sprint 2", "Sprint 3", "Sprint 4"])).toBe(
      "Sprint 5",
    );
  });

  it("ignores case and surrounding space when comparing", () => {
    // Two sprints called "Sprint 2" and "sprint 2" are a duplicate to every
    // human who looks at the list.
    expect(nextSprintName("Sprint 1", ["  sPrInT 2 "])).toBe("Sprint 3");
  });

  it("is unchanged when the incremented name is free", () => {
    // The positive control: the skip must not fire on every call.
    expect(nextSprintName("Sprint 1", ["Sprint 7", "Hardening"])).toBe("Sprint 2");
  });

  it("behaves exactly as before when given no taken names", () => {
    expect(nextSprintName("Sprint 1")).toBe("Sprint 2");
    expect(nextSprintName("Sprint 1", [])).toBe("Sprint 2");
  });

  it("still returns something for a name with no digits", () => {
    expect(nextSprintName("Hardening", ["Hardening 2"])).toBe("Hardening 3");
  });

  it("gives up rather than looping forever", () => {
    // A pathological project where everything is taken must still terminate and
    // return a usable string for the user to edit.
    const taken = Array.from({ length: 500 }, (_, i) => `Sprint ${i + 1}`);
    const out = nextSprintName("Sprint 1", taken);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
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
