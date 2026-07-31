import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { periodFor, samePeriod } from "./period";

/**
 * Pinned to a negative-offset zone for the same reason as date-only.test.ts:
 * period boundaries computed in local time land a day out west of UTC, and in
 * UTC that is invisible. Here the consequence is worse than a label — an hour
 * in the wrong period is an hour on the wrong cheque.
 */
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("periodFor — WEEKLY", () => {
  it("runs Monday to Sunday", () => {
    // 2026-07-22 is a Wednesday.
    expect(periodFor("2026-07-22", "WEEKLY")).toEqual({
      start: "2026-07-20",
      end: "2026-07-26",
    });
  });

  it("a Monday starts its own week", () => {
    expect(periodFor("2026-07-20", "WEEKLY").start).toBe("2026-07-20");
  });

  it("a SUNDAY closes the week it is in, not the one it starts", () => {
    // The off-by-one that a Sunday-based getUTCDay would get wrong.
    expect(periodFor("2026-07-26", "WEEKLY")).toEqual({
      start: "2026-07-20",
      end: "2026-07-26",
    });
  });

  it("spans a month boundary without resetting", () => {
    // Wed 2026-07-29 -> week runs into August.
    expect(periodFor("2026-07-29", "WEEKLY")).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
    });
  });

  it("accepts a full ISO instant, not just a bare date", () => {
    expect(periodFor("2026-07-22T00:00:00.000Z", "WEEKLY").start).toBe(
      "2026-07-20",
    );
  });
});

describe("periodFor — BIWEEKLY", () => {
  it("produces 14-day blocks", () => {
    const p = periodFor("2026-07-22", "BIWEEKLY");
    const days =
      (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 + 1;
    expect(days).toBe(14);
  });

  it("always starts on a Monday", () => {
    for (const d of ["2026-01-01", "2026-07-22", "2026-12-31"]) {
      const start = new Date(periodFor(d, "BIWEEKLY").start + "T00:00:00Z");
      expect(start.getUTCDay()).toBe(1); // Monday
    }
  });

  it("consecutive weeks share a block, then flip", () => {
    const a = periodFor("2026-07-20", "BIWEEKLY").start;
    const b = periodFor("2026-07-27", "BIWEEKLY").start;
    const c = periodFor("2026-08-03", "BIWEEKLY").start;
    // Exactly one of the two following weeks is in the same block as the first.
    expect([a === b, a === c].filter(Boolean)).toHaveLength(1);
  });

  it("dates BEFORE the anchor still land on a block boundary", () => {
    const start = new Date(periodFor("1965-03-10", "BIWEEKLY").start + "T00:00:00Z");
    expect(start.getUTCDay()).toBe(1);
  });
});

/**
 * The invariant that actually matters, and the one a hand-picked example can
 * miss: a period must CONTAIN the day it was computed for.
 *
 * Added after a surviving mutant. `Math.trunc` for the biweekly block passed
 * the "starts on a Monday" test — it still returns a Monday, just the wrong
 * one, and for pre-anchor dates it rounds toward zero and produces a period
 * that begins AFTER the date it is supposed to contain. The example date first
 * chosen happened to sit exactly on a block boundary, where floor and trunc
 * agree, so the test proved nothing.
 */
describe("every period contains its own date", () => {
  const LENGTHS = ["WEEKLY", "BIWEEKLY", "SEMIMONTHLY"] as const;
  const DATES = [
    "1965-03-10", // before the biweekly anchor — where trunc diverges
    "1969-12-31",
    "1970-01-05", // the anchor itself
    "2026-01-01",
    "2026-02-28",
    "2028-02-29", // leap day
    "2026-07-15", // semi-monthly boundary
    "2026-07-16",
    "2026-12-31",
  ];

  for (const length of LENGTHS) {
    for (const date of DATES) {
      it(`${length} @ ${date}`, () => {
        const { start, end } = periodFor(date, length);
        expect(start <= date).toBe(true);
        expect(date <= end).toBe(true);
        expect(start <= end).toBe(true);
      });
    }
  }
});

/**
 * Run the boundaries under several zones, including a POSITIVE offset.
 *
 * Also added after a surviving mutant: constructing dates in local time instead
 * of UTC is invisible at UTC-4 (local midnight is 04:00Z the SAME day) but
 * shifts the date back a day at UTC+9 (local midnight is 15:00Z the day
 * before). Pinning the suite to one western zone — the right call for display
 * formatting — cannot catch this direction at all.
 */
describe("period boundaries are timezone-independent", () => {
  const ZONES = ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"];

  for (const tz of ZONES) {
    it(`identical results in ${tz}`, () => {
      const previous = process.env.TZ;
      process.env.TZ = tz;
      try {
        expect(periodFor("2026-07-22", "WEEKLY")).toEqual({
          start: "2026-07-20",
          end: "2026-07-26",
        });
        expect(periodFor("2026-07-16", "SEMIMONTHLY")).toEqual({
          start: "2026-07-16",
          end: "2026-07-31",
        });
        // The 1st and the last day of a month are where a shift shows first.
        expect(periodFor("2026-03-01", "SEMIMONTHLY").start).toBe("2026-03-01");
        expect(periodFor("2026-03-31", "SEMIMONTHLY").end).toBe("2026-03-31");
      } finally {
        process.env.TZ = previous;
      }
    });
  }
});

describe("periodFor — SEMIMONTHLY", () => {
  it("the 1st-15th is the first half", () => {
    expect(periodFor("2026-07-09", "SEMIMONTHLY")).toEqual({
      start: "2026-07-01",
      end: "2026-07-15",
    });
  });

  it("the 15th belongs to the FIRST half, not the second", () => {
    expect(periodFor("2026-07-15", "SEMIMONTHLY").end).toBe("2026-07-15");
  });

  it("the 16th opens the second half", () => {
    expect(periodFor("2026-07-16", "SEMIMONTHLY")).toEqual({
      start: "2026-07-16",
      end: "2026-07-31",
    });
  });

  it("ends on the real last day of a 30-day month", () => {
    expect(periodFor("2026-06-20", "SEMIMONTHLY").end).toBe("2026-06-30");
  });

  it("handles February in a NON-leap year", () => {
    expect(periodFor("2026-02-20", "SEMIMONTHLY").end).toBe("2026-02-28");
  });

  it("handles February in a LEAP year", () => {
    expect(periodFor("2028-02-20", "SEMIMONTHLY").end).toBe("2028-02-29");
  });

  it("rolls the year over from December", () => {
    expect(periodFor("2026-12-20", "SEMIMONTHLY")).toEqual({
      start: "2026-12-16",
      end: "2026-12-31",
    });
  });
});

describe("samePeriod", () => {
  it("splits a single WEEK across two semi-monthly periods", () => {
    // The decision this whole design rests on: the week of Mon 2026-07-13
    // contains the 15th, so Mon-Wed and Thu-Sun are DIFFERENT pay periods.
    // Resolving per entry is what gets this right; snapping to the week's
    // Monday would drag the whole week into the first half.
    expect(samePeriod("2026-07-13", "2026-07-15", "SEMIMONTHLY")).toBe(true);
    expect(samePeriod("2026-07-15", "2026-07-16", "SEMIMONTHLY")).toBe(false);
    // ...while weekly keeps them together, as it should.
    expect(samePeriod("2026-07-15", "2026-07-16", "WEEKLY")).toBe(true);
  });

  it("is false across a weekly boundary", () => {
    expect(samePeriod("2026-07-26", "2026-07-27", "WEEKLY")).toBe(false);
  });
});
