import { describe, it, expect } from "vitest";
import { calendarDateInput, toCalendarNoonUTC } from "./date-input";

describe("toCalendarNoonUTC — day-safe calendar dates (off-by-one fix)", () => {
  it("snaps a bare date to NOON UTC of that day (never the day before)", () => {
    const d = toCalendarNoonUTC("2026-07-24")!;
    expect(d.toISOString()).toBe("2026-07-24T12:00:00.000Z");
  });

  it("snaps the model's typical UTC-midnight timestamp to noon of the SAME day", () => {
    // "2026-07-24T00:00:00Z" stored verbatim shows as Jul 23 in the Americas.
    const d = toCalendarNoonUTC("2026-07-24T00:00:00Z")!;
    expect(d.toISOString()).toBe("2026-07-24T12:00:00.000Z");
  });

  it("keeps the intended day for a local-offset midnight (Eastern)", () => {
    // 2026-07-24 00:00 -04:00 === 2026-07-24T04:00Z → still the 24th.
    const d = toCalendarNoonUTC("2026-07-24T00:00:00-04:00")!;
    expect(d.toISOString()).toBe("2026-07-24T12:00:00.000Z");
  });

  it("renders on the intended calendar day in a western timezone", () => {
    const d = toCalendarNoonUTC("2026-07-24")!;
    const laDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(d);
    expect(laDay).toBe("2026-07-24");
  });

  it("returns null for null/empty/unparseable input", () => {
    expect(toCalendarNoonUTC(null)).toBeNull();
    expect(toCalendarNoonUTC(undefined)).toBeNull();
    expect(toCalendarNoonUTC("")).toBeNull();
    expect(toCalendarNoonUTC("not-a-date")).toBeNull();
  });
});

describe("calendarDateInput — accepts date-only and ISO", () => {
  it("accepts a bare calendar date", () => {
    expect(calendarDateInput.safeParse("2026-07-24").success).toBe(true);
  });
  it("accepts a full ISO datetime", () => {
    expect(calendarDateInput.safeParse("2026-07-24T00:00:00Z").success).toBe(true);
  });
  it("rejects a non-date string", () => {
    expect(calendarDateInput.safeParse("someday").success).toBe(false);
  });
});
