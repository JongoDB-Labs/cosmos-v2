import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dateOnlyKey, formatDateOnly, byDateOnlyDesc } from "./date-only";

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

describe("formatDateOnly", () => {
  it("renders the stored calendar day, not the viewer's shifted one", () => {
    // The whole bug in one assertion: naive parsing yields 7/19 here.
    expect(formatDateOnly(UTC_MIDNIGHT, "en-US")).toBe("7/20/2026");
  });

  it("does NOT agree with the naive Date-based formatting it replaces", () => {
    // Proves the test is measuring something: if these ever matched, the
    // helper would be a no-op and the assertion above would be vacuous.
    const naive = new Date(UTC_MIDNIGHT).toLocaleDateString("en-US");
    expect(naive).toBe("7/19/2026");
    expect(formatDateOnly(UTC_MIDNIGHT, "en-US")).not.toBe(naive);
  });

  it("accepts a bare YYYY-MM-DD just as well", () => {
    expect(formatDateOnly("2026-07-20", "en-US")).toBe("7/20/2026");
  });

  it("handles a New Year boundary, where the shift changes the YEAR", () => {
    expect(formatDateOnly("2026-01-01T00:00:00.000Z", "en-US")).toBe("1/1/2026");
  });

  it("passes unparseable input through rather than rendering 'Invalid Date'", () => {
    expect(formatDateOnly("not-a-date", "en-US")).toBe("not-a-date");
  });
});

describe("dateOnlyKey", () => {
  it("is the same key the week grid groups on", () => {
    expect(dateOnlyKey(UTC_MIDNIGHT)).toBe("2026-07-20");
    expect(dateOnlyKey("2026-07-20")).toBe("2026-07-20");
  });

  it("agrees with formatDateOnly about which day it is", () => {
    // The real defect was these two DISAGREEING. Same source value, same day.
    const key = dateOnlyKey(UTC_MIDNIGHT);
    expect(formatDateOnly(UTC_MIDNIGHT, "en-US")).toBe(
      formatDateOnly(key, "en-US"),
    );
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
