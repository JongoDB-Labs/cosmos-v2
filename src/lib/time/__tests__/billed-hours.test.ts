// The one rule that must not be re-derived per call site: null bills as logged,
// and an explicit 0 is a decision rather than an absence.
import { describe, expect, it } from "vitest";
import { billedHoursOf, billingVariance, isWrittenDown } from "../billed-hours";

describe("billedHoursOf", () => {
  it("bills what was logged when nobody has decided otherwise", () => {
    expect(billedHoursOf({ hours: 7.5, billedHours: null })).toBe(7.5);
  });

  it("bills the decided figure when there is one", () => {
    expect(billedHoursOf({ hours: 10, billedHours: 8 })).toBe(8);
  });

  it("treats an explicit zero as a decision, not an absence", () => {
    // The `||` bug: worked-but-not-billed silently becomes billed-in-full, and
    // it shows up as an invoice nobody meant to send.
    expect(billedHoursOf({ hours: 6, billedHours: 0 })).toBe(0);
  });

  it("can bill above the log, for an agreed write-up", () => {
    expect(billedHoursOf({ hours: 4, billedHours: 6 })).toBe(6);
  });
});

describe("billingVariance", () => {
  it("is zero when billing as logged", () => {
    expect(billingVariance({ hours: 8, billedHours: null })).toBe(0);
  });

  it("is negative for a write-down and positive for a write-up", () => {
    expect(billingVariance({ hours: 10, billedHours: 8 })).toBe(-2);
    expect(billingVariance({ hours: 4, billedHours: 6 })).toBe(2);
  });

  it("reports the full write-down when nothing is billed", () => {
    expect(billingVariance({ hours: 6, billedHours: 0 })).toBe(-6);
  });
});

describe("isWrittenDown", () => {
  it("is false when there is no decision, even against a large log", () => {
    expect(isWrittenDown({ hours: 100, billedHours: null })).toBe(false);
  });

  it("is true only for a decision below the log", () => {
    expect(isWrittenDown({ hours: 10, billedHours: 8 })).toBe(true);
    expect(isWrittenDown({ hours: 10, billedHours: 0 })).toBe(true);
    expect(isWrittenDown({ hours: 10, billedHours: 10 })).toBe(false);
    expect(isWrittenDown({ hours: 10, billedHours: 12 })).toBe(false);
  });
});
