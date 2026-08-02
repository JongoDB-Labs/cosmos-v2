// @vitest-environment node
//
// A notification about a submitted timesheet deep-links to `?week=YYYY-MM-DD`.
// Following it landed an approver a FULL WEEK EARLY — on a week with no hours
// in it — for anyone west of UTC.
//
// Cause: the param was parsed at UTC midnight, but the week grid does all of
// its arithmetic in LOCAL time (getDay / setDate / setHours). Midnight UTC on
// Monday is Sunday evening in New York, so `getDay()` returned 0 and the
// "rewind to Monday" branch went back a further six days.
//
// TIMEZONE-PINNED, and pinned in BOTH directions on purpose. The bug is
// invisible at UTC and at positive offsets — a test that ran only in CI's UTC
// would have passed against the broken code, which is exactly how it shipped.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseWeekParam } from "./time-tracker";

/**
 * Mirrors getWeekDates(), which is not exported. Kept in step deliberately: the
 * bug lives in the INTERACTION between the parse and this arithmetic, so a test
 * of the parse alone would prove nothing about the week actually shown.
 */
function mondayOfWeekGrid(base: Date): string {
  const start = new Date(base);
  const day = start.getDay();
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  start.setHours(0, 0, 0, 0);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(
    start.getDate(),
  ).padStart(2, "0")}`;
}

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe("parseWeekParam", () => {
  // Kiritimati is +14, the largest positive offset in use; New York is the
  // negative case that actually broke.
  for (const tz of ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    it(`opens the week the notification linked to, in ${tz}`, () => {
      process.env.TZ = tz;
      const week = "2026-07-27"; // a Monday
      expect(mondayOfWeekGrid(parseWeekParam(week)!)).toBe(week);
    });

    it(`handles a week starting on the 1st of a month, in ${tz}`, () => {
      // Month boundaries are where local/UTC drift stops being a same-month
      // off-by-one and becomes a different month entirely.
      process.env.TZ = tz;
      const week = "2026-06-01"; // also a Monday
      expect(mondayOfWeekGrid(parseWeekParam(week)!)).toBe(week);
    });
  }

  it("rejects anything that is not a plain YYYY-MM-DD", () => {
    // The value comes off a URL, so it is attacker-supplied in the trivial
    // sense: it must never become an Invalid Date the grid then renders from.
    for (const bad of [null, "", "not-a-date", "2026-7-1", "2026-07-27T00:00:00Z", "../../etc"]) {
      expect(parseWeekParam(bad)).toBeNull();
    }
  });

  it("rejects a well-formed but impossible date", () => {
    // Passes the shape check and is still rejected — which is the point: the
    // NaN check, not the regex, is what does the work. Removing the regex was
    // mutation-tested and found EQUIVALENT (no input distinguishes them, since
    // appending a time to any malformed string yields an Invalid Date), so do
    // not go hunting for a test that kills it. There isn't one.
    expect(parseWeekParam("2026-13-45")).toBeNull();
  });

  it("is LOCAL midnight, not UTC midnight", () => {
    // The distinction the whole bug turned on. At a negative offset the two are
    // different calendar days.
    process.env.TZ = "America/New_York";
    const d = parseWeekParam("2026-07-27")!;
    expect(d.getDate()).toBe(27);
    expect(d.getHours()).toBe(0);
  });
});
