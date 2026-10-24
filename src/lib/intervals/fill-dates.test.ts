import { describe, it, expect } from "vitest";
import { datesFromInterval, plannedDayToIso } from "./fill-dates";

const SPRINT = { startDate: "2026-11-02T00:00:00.000Z", endDate: "2026-11-13T00:00:00.000Z" };

describe("datesFromInterval (COSMOS-223)", () => {
  it("fills both planned dates when the item has neither", () => {
    expect(datesFromInterval({ startDate: "", dueDate: "" }, SPRINT)).toEqual({
      startDate: "2026-11-02",
      dueDate: "2026-11-13",
    });
  });

  it("never overwrites a date already set", () => {
    expect(datesFromInterval({ startDate: "2026-10-30", dueDate: "" }, SPRINT)).toEqual({
      dueDate: "2026-11-13",
    });
    expect(datesFromInterval({ startDate: "", dueDate: "2026-12-01" }, SPRINT)).toEqual({
      startDate: "2026-11-02",
    });
    expect(datesFromInterval({ startDate: "2026-10-30", dueDate: "2026-12-01" }, SPRINT)).toEqual({});
  });

  it("fills nothing without an interval, or from one without dates", () => {
    expect(datesFromInterval({ startDate: "", dueDate: "" }, null)).toEqual({});
    expect(datesFromInterval({ startDate: "", dueDate: "" }, { startDate: null, endDate: null })).toEqual({});
  });

  it("sends a day as UTC midnight, like the date pickers", () => {
    expect(plannedDayToIso("2026-11-02")).toBe("2026-11-02T00:00:00.000Z");
  });
});
