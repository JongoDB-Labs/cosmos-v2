import { describe, it, expect, beforeAll } from "vitest";

/**
 * These dates render during SSR, so the server and the browser must produce
 * BYTE-IDENTICAL text. `toLocaleDateString()` with no arguments does not: it
 * uses the runtime's locale and time zone, so a UTC container and a browser in
 * America/New_York disagree, React throws hydration error #418, and the user
 * gets a "Something went wrong" toast on the projects list.
 *
 * The assertions that matter are the ones that vary the AMBIENT environment — a
 * formatter that reads it will fail them. That only works if the ambient zone is
 * actually something other than UTC, which is why this file FORCES one rather
 * than trusting the machine: written the obvious way these tests pass on any UTC
 * runner whether or not the `timeZone` pin exists, and CI is a UTC runner. The
 * zone is set before the import because the module builds its
 * `Intl.DateTimeFormat`s at import time and a formatter captures the zone when
 * it is constructed.
 *
 * `the harness actually shifts the day` is the positive control for all of it.
 */
let fmt: typeof import("./stable-date");

beforeAll(async () => {
  process.env.TZ = "America/New_York";
  fmt = await import("./stable-date");
});

describe("the harness actually shifts the day", () => {
  it("renders midnight UTC as the previous day without a pin", () => {
    // If this ever reads "28", the forced zone did not take effect and every
    // UTC assertion below is vacuous. This test is the reason to trust them.
    const unpinned = new Date("2026-07-28T00:00:00.000Z").toLocaleDateString(
      "en-US",
      { day: "numeric", month: "short", year: "numeric" },
    );
    expect(unpinned).toBe("Jul 27, 2026");
  });
});

describe("formatDateStable", () => {
  const iso = "2026-07-30T23:30:00.000Z";

  it("formats a date", () => {
    expect(fmt.formatDateStable(iso)).toBe("7/30/2026");
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    // 02:00 UTC on the 31st is 22:00 on the 30th in America/New_York. A
    // formatter reading the ambient zone returns "7/30/2026" here — precisely
    // the server/browser split that throws #418. Pinned to UTC it says the 31st.
    expect(fmt.formatDateStable("2026-07-31T02:00:00.000Z")).toBe("7/31/2026");
  });

  it("does NOT depend on the ambient locale", () => {
    // en-GB would render 30/07/2026. Pinning the locale is what stops the
    // server and a European browser disagreeing.
    expect(fmt.formatDateStable(iso)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(fmt.formatDateStable(iso).startsWith("7/")).toBe(true);
  });

  it("accepts a Date as well as a string", () => {
    expect(fmt.formatDateStable(new Date(iso))).toBe("7/30/2026");
  });

  it("returns empty string for absent or unparseable input", () => {
    // Rendering "Invalid Date" or "NaN" to a user is worse than rendering
    // nothing, and both would also differ across runtimes.
    expect(fmt.formatDateStable(null)).toBe("");
    expect(fmt.formatDateStable(undefined)).toBe("");
    expect(fmt.formatDateStable("")).toBe("");
    expect(fmt.formatDateStable("not-a-date")).toBe("");
  });
});

describe("formatDateLongStable", () => {
  it("formats a long date", () => {
    expect(fmt.formatDateLongStable("2026-07-30T12:00:00.000Z")).toBe(
      "July 30, 2026",
    );
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    expect(fmt.formatDateLongStable("2026-07-31T02:00:00.000Z")).toBe(
      "July 31, 2026",
    );
  });

  it("crosses a year boundary in UTC, not locally", () => {
    // 01:00 UTC on Jan 1 is still Dec 31 in New York — the shift changes the
    // YEAR, which is the most visible way this goes wrong.
    expect(fmt.formatDateLongStable("2027-01-01T01:00:00.000Z")).toBe(
      "January 1, 2027",
    );
  });

  it("returns empty string for absent or unparseable input", () => {
    expect(fmt.formatDateLongStable(null)).toBe("");
    expect(fmt.formatDateLongStable(undefined)).toBe("");
    expect(fmt.formatDateLongStable("nope")).toBe("");
  });
});

describe("formatDateShortStable", () => {
  it("formats a short date", () => {
    expect(fmt.formatDateShortStable("2026-06-14T00:00:00.000Z")).toBe("Jun 14");
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    expect(fmt.formatDateShortStable("2026-07-31T02:00:00.000Z")).toBe("Jul 31");
  });

  it("returns empty string for absent input", () => {
    expect(fmt.formatDateShortStable(null)).toBe("");
    expect(fmt.formatDateShortStable("nope")).toBe("");
  });
});

/**
 * The sprint-window format. Sprint and increment boundaries are calendar days
 * stored at midnight UTC, so the ceremony boards' Summary tab showed every
 * reader behind UTC the day BEFORE the sprint started.
 */
describe("formatDateMediumStable", () => {
  it("keeps the calendar day a reader behind UTC would otherwise lose", () => {
    expect(fmt.formatDateMediumStable("2026-07-28T00:00:00.000Z")).toBe(
      "Jul 28, 2026",
    );
  });

  it("accepts a bare calendar date", () => {
    // `computeNextSprintDefaults` returns YYYY-MM-DD, not an ISO instant.
    expect(fmt.formatDateMediumStable("2026-07-28")).toBe("Jul 28, 2026");
  });

  it("crosses a year boundary in UTC, not locally", () => {
    expect(fmt.formatDateMediumStable("2027-01-01T01:00:00.000Z")).toBe(
      "Jan 1, 2027",
    );
  });

  it("accepts a Date as well as a string", () => {
    expect(fmt.formatDateMediumStable(new Date("2026-07-28T00:00:00.000Z"))).toBe(
      "Jul 28, 2026",
    );
  });

  it("returns empty string for absent or unparseable input", () => {
    expect(fmt.formatDateMediumStable(null)).toBe("");
    expect(fmt.formatDateMediumStable(undefined)).toBe("");
    expect(fmt.formatDateMediumStable("")).toBe("");
    expect(fmt.formatDateMediumStable("not a date")).toBe("");
  });
});
