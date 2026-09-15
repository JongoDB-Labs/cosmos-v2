import { describe, it, expect } from "vitest";
import { localDateString } from "./local-date";

/**
 * "Today" is a LOCAL question. Deriving it with toISOString() answers it in UTC,
 * so a viewer west of UTC gets tomorrow for the last hours of their day — the
 * timesheet defaulted to tomorrow after 8pm Eastern, and a journal entry would
 * post into the wrong day.
 *
 * Distinct from reading back a STORED calendar date, which must stay in UTC: a
 * Postgres DATE serialises at UTC midnight, and converting that to a local zone
 * shows the previous day (the 7/19-vs-7/20 comment in time-tracker).
 *
 * These assert the contract without mocking the zone. Mocking getTimezoneOffset
 * does NOT change what getFullYear/getMonth/getDate return, so a test written
 * that way proves nothing about either the code or a mutation of it.
 *
 * Instead: a Date built from LOCAL components must format back to those same
 * components, whatever zone the machine runs in. The two edge times are chosen
 * so `toISOString()` breaks at least one of them on any machine that is not
 * exactly UTC — late-evening rolls forward west of UTC, early-morning rolls
 * back east of it.
 */

describe("localDateString", () => {
  it("keeps a late-evening local time on the SAME day", () => {
    // 23:30 local. In UTC this is already tomorrow anywhere west of UTC.
    expect(localDateString(new Date(2026, 7, 11, 23, 30))).toBe("2026-08-11");
  });

  it("keeps an early-morning local time on the same day", () => {
    // 00:30 local. In UTC this is still yesterday anywhere east of UTC.
    expect(localDateString(new Date(2026, 7, 11, 0, 30))).toBe("2026-08-11");
  });

  it("zero-pads month and day so it sorts and matches a DATE column", () => {
    expect(localDateString(new Date(2026, 2, 5, 12, 0))).toBe("2026-03-05");
  });

  it("handles the last day of a year without rolling over", () => {
    expect(localDateString(new Date(2026, 11, 31, 22, 0))).toBe("2026-12-31");
  });

  it("defaults to now, and agrees with the machine's own local calendar", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(localDateString()).toBe(expected);
  });
});
