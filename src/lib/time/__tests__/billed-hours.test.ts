// The one rule that must not be re-derived per call site: null bills as logged,
// and an explicit 0 is a decision rather than an absence.
import { describe, expect, it } from "vitest";
import { billedHoursOf } from "../billed-hours";

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
