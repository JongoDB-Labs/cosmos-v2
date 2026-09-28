import { describe, it, expect } from "vitest";
import {
  isWeekend,
  workingDaysBetween,
  hoursInWindow,
  totalHours,
  RESERVES_CAPACITY,
} from "./time-off";

// 2026-09-21 is a Monday; 2026-09-26 a Saturday; 2026-09-27 a Sunday.
const MON = "2026-09-21";
const FRI = "2026-09-25";
const SAT = "2026-09-26";
const SUN = "2026-09-27";
const NEXT_MON = "2026-09-28";

describe("isWeekend", () => {
  it("knows the weekend from the working week", () => {
    expect(isWeekend(SAT)).toBe(true);
    expect(isWeekend(SUN)).toBe(true);
    expect(isWeekend(MON)).toBe(false);
    expect(isWeekend(FRI)).toBe(false);
  });
});

describe("workingDaysBetween", () => {
  it("counts an inclusive working week as five days", () => {
    expect(workingDaysBetween(MON, FRI)).toBe(5);
  });

  it("does not count the weekend a long break spans", () => {
    // Friday to Monday is two days away, not four.
    expect(workingDaysBetween(FRI, NEXT_MON)).toBe(2);
  });

  it("counts a single day as one, and a weekend day as none", () => {
    expect(workingDaysBetween(MON, MON)).toBe(1);
    expect(workingDaysBetween(SAT, SUN)).toBe(0);
  });

  it("is zero when the range runs backwards rather than negative", () => {
    expect(workingDaysBetween(FRI, MON)).toBe(0);
  });
});

describe("hoursInWindow", () => {
  const fortnight = { startDate: "2026-09-14", endDate: "2026-09-25", hoursPerDay: 8 };

  it("gives each week only its own days, not the whole request", () => {
    // The point of clamping: a containment test would hand one of these weeks
    // 80 hours and the other two nothing.
    expect(hoursInWindow(fortnight, "2026-09-14", "2026-09-20")).toBe(40);
    expect(hoursInWindow(fortnight, MON, SUN)).toBe(40);
    expect(hoursInWindow(fortnight, NEXT_MON, "2026-10-04")).toBe(0);
  });

  it("clamps a request that starts before the window", () => {
    // Leave from the Wednesday before: this week owes only Mon-Fri.
    const long = { startDate: "2026-09-16", endDate: FRI, hoursPerDay: 8 };
    expect(hoursInWindow(long, MON, SUN)).toBe(40);
  });

  it("carries a half day through as a half day", () => {
    expect(hoursInWindow({ startDate: MON, endDate: MON, hoursPerDay: 4 }, MON, SUN)).toBe(4);
  });

  it("is zero for a window the leave does not touch", () => {
    expect(hoursInWindow(fortnight, "2026-11-02", "2026-11-08")).toBe(0);
  });
});

describe("totalHours", () => {
  it("is the working days times the daily figure", () => {
    expect(totalHours({ startDate: MON, endDate: FRI, hoursPerDay: 8 })).toBe(40);
    expect(totalHours({ startDate: FRI, endDate: NEXT_MON, hoursPerDay: 8 })).toBe(16);
  });
});

describe("RESERVES_CAPACITY", () => {
  it("counts a request nobody has decided on yet", () => {
    // A board that showed only approved leave would show the team as available
    // right up until it was too late to staff around it.
    expect([...RESERVES_CAPACITY]).toEqual(["PENDING", "APPROVED"]);
  });

  it("does not count one that was denied or taken back", () => {
    expect(RESERVES_CAPACITY).not.toContain("DENIED");
    expect(RESERVES_CAPACITY).not.toContain("WITHDRAWN");
  });
});
