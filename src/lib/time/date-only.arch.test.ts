import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A date-ONLY value must never be parsed as an instant.
 *
 * `TimeEntry.date` is a Postgres `DATE`, serialised by Prisma at UTC midnight
 * (`"2026-07-20T00:00:00.000Z"`). `new Date(...)` on that yields a moment,
 * which any locale formatter then shifts into the viewer's zone — a day
 * earlier anywhere west of UTC. Production showed the list view rendering
 * 7/19 for an entry the week grid drew on Jul 20.
 *
 * The unit tests in `date-only.test.ts` prove the helper is right. This asserts
 * the RULE at the call site, because the bug is not a broken function — it is
 * reaching for the wrong one, and it reads as completely ordinary code:
 *
 *     {new Date(row.original.date).toLocaleDateString()}
 *
 * It also cannot be caught by tests running in UTC, which is why it survived.
 * A source-level check has no timezone.
 */
const TIME_TRACKER = "src/components/time-tracking/time-tracker.tsx";

/** `new Date(<anything>.date)` — an entry date parsed as an instant. */
const DATE_AS_INSTANT = /new Date\([^)]*\.date[^)]*\)/;

describe("time entry dates are never parsed as instants", () => {
  const src = readFileSync(TIME_TRACKER, "utf8");

  it("scanned the real file", () => {
    // A rename must fail loudly rather than scan nothing and pass.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("formatDateOnly");
  });

  it("the time tracker never wraps an entry date in new Date()", () => {
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => DATE_AS_INSTANT.test(line))
      // `form.date` is a plain YYYY-MM-DD from a date input, and the create
      // path sends it as a string; only ENTRY dates off the API are at risk.
      .filter(({ line }) => !line.includes("form.date"));

    expect(offenders).toEqual([]);
  });

  it("formats and groups through the shared helper", () => {
    // Both call sites reading from one helper is what stops the list view and
    // the week grid disagreeing about which day an entry belongs to.
    expect(src).toContain("formatDateOnly(row.original.date)");
    expect(src).toContain("dateOnlyKey(e.date) === date");
  });
});
