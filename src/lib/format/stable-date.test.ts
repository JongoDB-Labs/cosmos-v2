import { describe, it, expect } from "vitest";
import {
  formatDateStable,
  formatDateShortStable,
  formatDateLongStable,
} from "./stable-date";

/**
 * These dates render during SSR, so the server and the browser must produce
 * BYTE-IDENTICAL text. `toLocaleDateString()` with no arguments does not: it
 * uses the runtime's locale and time zone, so a UTC container and a browser in
 * America/New_York disagree, React throws hydration error #418, and the user
 * gets a "Something went wrong" toast on the projects list.
 *
 * The assertions that matter are the two that vary the AMBIENT environment —
 * a formatter that reads it will fail them.
 */
describe("formatDateStable", () => {
  const iso = "2026-07-30T23:30:00.000Z";

  it("formats a date", () => {
    expect(formatDateStable(iso)).toBe("7/30/2026");
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    // 02:00 UTC on the 31st is 22:00 on the 30th in America/New_York (this
    // machine, and a plausible user). A formatter reading the ambient zone
    // returns "7/30/2026" here — which is precisely the server/browser split
    // that throws #418. Pinned to UTC it must say the 31st.
    expect(formatDateStable("2026-07-31T02:00:00.000Z")).toBe("7/31/2026");
  });

  it("does NOT depend on the ambient locale", () => {
    // en-GB would render 30/07/2026. Pinning the locale is what stops the
    // server and a European browser disagreeing.
    expect(formatDateStable(iso)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(formatDateStable(iso).startsWith("7/")).toBe(true);
  });

  it("accepts a Date as well as a string", () => {
    expect(formatDateStable(new Date(iso))).toBe("7/30/2026");
  });

  it("returns empty string for absent or unparseable input", () => {
    // Rendering "Invalid Date" or "NaN" to a user is worse than rendering
    // nothing, and both would also differ across runtimes.
    expect(formatDateStable(null)).toBe("");
    expect(formatDateStable(undefined)).toBe("");
    expect(formatDateStable("")).toBe("");
    expect(formatDateStable("not-a-date")).toBe("");
  });
});

describe("formatDateLongStable", () => {
  it("formats a long date", () => {
    expect(formatDateLongStable("2026-07-30T12:00:00.000Z")).toBe("July 30, 2026");
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    // 02:00 UTC on the 31st is 22:00 on the 30th in America/New_York. A
    // formatter reading the ambient zone returns "July 30, 2026" here.
    expect(formatDateLongStable("2026-07-31T02:00:00.000Z")).toBe("July 31, 2026");
  });

  it("crosses a year boundary in UTC, not locally", () => {
    // 01:00 UTC on Jan 1 is still Dec 31 in New York — the shift changes the
    // YEAR, which is the most visible way this goes wrong.
    expect(formatDateLongStable("2027-01-01T01:00:00.000Z")).toBe("January 1, 2027");
  });

  it("returns empty string for absent or unparseable input", () => {
    expect(formatDateLongStable(null)).toBe("");
    expect(formatDateLongStable(undefined)).toBe("");
    expect(formatDateLongStable("nope")).toBe("");
  });
});

describe("formatDateShortStable", () => {
  it("formats a short date", () => {
    expect(formatDateShortStable("2026-06-14T00:00:00.000Z")).toBe("Jun 14");
  });

  it("uses UTC, not the machine's zone, when the two disagree on the day", () => {
    expect(formatDateShortStable("2026-07-31T02:00:00.000Z")).toBe("Jul 31");
  });

  it("returns empty string for absent input", () => {
    expect(formatDateShortStable(null)).toBe("");
    expect(formatDateShortStable("nope")).toBe("");
  });
});
