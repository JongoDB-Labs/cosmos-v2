import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dateOnlyKey, byDateOnlyDesc } from "./date-only";
import { formatDateStable } from "@/lib/format/stable-date";

/**
 * The bug these guard, reproduced from production data:
 *
 *   raw from API          "2026-07-20T00:00:00.000Z"   (Postgres DATE)
 *   list view rendered    "7/19/2026"                  <- a day early
 *   week grid bucketed    "2026-07-20"                 <- correct
 *
 * The list called `new Date(value).toLocaleDateString()`, which converts UTC
 * midnight into the viewer's zone. Every one of these tests must fail if that
 * conversion comes back, so the suite is pinned to a NEGATIVE-offset timezone —
 * in UTC or east of it the bug is invisible, which is why it survived.
 */
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York"; // UTC-4/-5, where the shift shows
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

/** Exactly what Prisma returns for a `@db.Date` column. */
const UTC_MIDNIGHT = "2026-07-20T00:00:00.000Z";

/**
 * Display now goes through `formatDateStable`, which pins the formatter to UTC.
 * That is a strictly stronger guarantee than the `formatDateOnly` it replaced:
 * it keeps the calendar day AND renders identically on server and client, so a
 * date-only value can be shown during SSR without tripping hydration error
 * #418. These assertions are the originals, re-pointed at it.
 */
describe("formatDateStable, on date-only values", () => {
  it("renders the stored calendar day, not the viewer's shifted one", () => {
    // The whole bug in one assertion: naive parsing yields 7/19 here.
    expect(formatDateStable(UTC_MIDNIGHT)).toBe("7/20/2026");
  });

  it("does NOT agree with the naive Date-based formatting it replaces", () => {
    // Proves the test is measuring something: if these ever matched, the
    // helper would be a no-op and the assertion above would be vacuous.
    const naive = new Date(UTC_MIDNIGHT).toLocaleDateString("en-US");
    expect(naive).toBe("7/19/2026");
    expect(formatDateStable(UTC_MIDNIGHT)).not.toBe(naive);
  });

  it("accepts a bare YYYY-MM-DD just as well", () => {
    expect(formatDateStable("2026-07-20")).toBe("7/20/2026");
  });

  it("handles a New Year boundary, where the shift changes the YEAR", () => {
    expect(formatDateStable("2026-01-01T00:00:00.000Z")).toBe("1/1/2026");
  });

  it("renders nothing for unparseable input", () => {
    // A deliberate change from `formatDateOnly`, which echoed the raw string
    // back. `TimeEntry.date` is a Postgres DATE, so the API cannot deliver an
    // unparseable value; showing an empty cell beats showing "not-a-date" to a
    // user, and it matches every other date on the screen.
    expect(formatDateStable("not-a-date")).toBe("");
  });

  it("agrees with dateOnlyKey about the day, which is what stops the drift", () => {
    // The list and the week grid disagreeing is the original production bug.
    // Both sides now read the value in UTC, so they cannot diverge.
    for (const v of [UTC_MIDNIGHT, "2026-07-20T23:30:00.000Z", "2026-12-31T00:00:00.000Z"]) {
      const [y, m, d] = dateOnlyKey(v).split("-").map(Number);
      expect(formatDateStable(v)).toBe(`${m}/${d}/${y}`);
    }
  });
});

describe("dateOnlyKey", () => {
  it("is the same key the week grid groups on", () => {
    expect(dateOnlyKey(UTC_MIDNIGHT)).toBe("2026-07-20");
    expect(dateOnlyKey("2026-07-20")).toBe("2026-07-20");
  });

  it("agrees with the display formatter about which day it is", () => {
    // The real defect was these two DISAGREEING. Same source value, same day —
    // whether it is formatted from the full instant or from the bucketed key.
    const key = dateOnlyKey(UTC_MIDNIGHT);
    expect(formatDateStable(UTC_MIDNIGHT)).toBe(formatDateStable(key));
  });
});

describe("byDateOnlyDesc", () => {
  it("orders most recent first", () => {
    const rows = [
      { date: "2026-07-19T00:00:00.000Z" },
      { date: "2026-07-21T00:00:00.000Z" },
      { date: "2026-07-20T00:00:00.000Z" },
    ];
    expect(rows.sort(byDateOnlyDesc).map((r) => dateOnlyKey(r.date))).toEqual([
      "2026-07-21",
      "2026-07-20",
      "2026-07-19",
    ]);
  });
});
