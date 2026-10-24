import { describe, it, expect } from "vitest";
import { applyRel, durationSeconds, endOf, literalRange, periodOffset, startOf, workingDaysFrom } from "../dates";

const THU = new Date("2026-10-15T15:00:00Z");

describe("dates", () => {
  it("weeks start on Monday, in the request time zone", () => {
    expect(startOf("week", THU, "UTC")).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect(startOf("week", THU, "UTC", -1)).toEqual(new Date("2026-10-05T00:00:00Z"));
    expect(endOf("week", THU, "UTC")).toEqual(new Date("2026-10-18T23:59:59.999Z"));
    // Sunday evening in Chicago is still that week's Sunday, not next Monday.
    const sunNight = new Date("2026-10-19T03:00:00Z"); // 22:00 Sunday in Chicago
    expect(startOf("week", sunNight, "America/Chicago")).toEqual(new Date("2026-10-12T05:00:00Z"));
    expect(startOf("week", sunNight, "UTC")).toEqual(new Date("2026-10-19T00:00:00Z"));
  });

  it("days, months and years, including a DST change and short months", () => {
    expect(startOf("day", THU, "Asia/Tokyo")).toEqual(new Date("2026-10-15T15:00:00Z"));
    expect(startOf("month", THU, "UTC")).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(startOf("year", THU, "UTC", -1)).toEqual(new Date("2025-01-01T00:00:00Z"));
    // 2026-11-01: US DST ends; the day after starts at 06:00Z, not 05:00Z.
    expect(startOf("day", new Date("2026-11-02T12:00:00Z"), "America/Chicago")).toEqual(new Date("2026-11-02T06:00:00Z"));
    expect(applyRel("+1M", new Date("2026-01-31T10:00:00Z"), "UTC")).toEqual(new Date("2026-02-28T10:00:00Z"));
  });

  it("JQL offsets are exact; working days skip weekends and land on a day start", () => {
    expect(applyRel("-7d", THU, "UTC")).toEqual(new Date("2026-10-08T15:00:00Z"));
    expect(applyRel("+2h", THU, "UTC")).toEqual(new Date("2026-10-15T17:00:00Z"));
    expect(applyRel("-30m", THU, "UTC")).toEqual(new Date("2026-10-15T14:30:00Z"));
    expect(applyRel("-1w", THU, "UTC")).toEqual(new Date("2026-10-08T15:00:00Z"));
    expect(applyRel("-1y", THU, "UTC")).toEqual(new Date("2025-10-15T15:00:00Z"));
    // Monday minus one working day is Friday.
    expect(workingDaysFrom(new Date("2026-10-19T09:00:00Z"), "UTC", -1)).toEqual(new Date("2026-10-16T00:00:00Z"));
    expect(applyRel("-3wd", THU, "UTC")).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect(applyRel("+2wd", new Date("2026-10-16T09:00:00Z"), "UTC")).toEqual(new Date("2026-10-20T00:00:00Z"));
  });

  it("period offsets: a bare number counts the period; units convert", () => {
    expect(periodOffset("week", { t: "num", v: -1 })).toBe(-1);
    expect(periodOffset("week", { t: "rel", v: "-1w" })).toBe(-1);
    expect(periodOffset("day", { t: "rel", v: "-1w" })).toBe(-7);
    expect(periodOffset("month", { t: "rel", v: "+1y" })).toBe(12);
    expect(periodOffset("day", undefined)).toBe(0);
  });

  it("literal dates are whole days in the zone; datetimes are instants", () => {
    expect(literalRange("2026-10-20", "UTC")).toEqual({ from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-21T00:00:00Z") });
    expect(literalRange("2026-10-20", "America/Chicago").from).toEqual(new Date("2026-10-20T05:00:00Z"));
    expect(literalRange("2026-10-20T10:00:00Z", "America/Chicago").from).toEqual(new Date("2026-10-20T10:00:00Z"));
  });

  it("estimate durations: 1d = 8h, 1w = 5d, no negatives or calendar units", () => {
    expect(durationSeconds("2h")).toBe(7200);
    expect(durationSeconds("1d")).toBe(28800);
    expect(durationSeconds("1w")).toBe(144000);
    expect(durationSeconds("-1d")).toBeNull();
    expect(durationSeconds("1M")).toBeNull();
  });
});
