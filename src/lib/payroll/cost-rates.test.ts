import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { resolveCostRate, utcToday, RATE_FLOOR, type CostRateHistory } from "./cost-rates";

const D = (s: string) => new Prisma.Decimal(s);
const on = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** As `loadCostRateHistory` returns them: newest first. */
const history: CostRateHistory = new Map([
  ["u1", [
    { effectiveFrom: on("2026-08-01"), costRate: D("120") },
    { effectiveFrom: on("2026-02-01"), costRate: D("110") },
    { effectiveFrom: RATE_FLOOR, costRate: D("100") },
  ]],
  ["never", []],
]);

describe("resolveCostRate", () => {
  it("returns the most recent rate that had taken effect", () => {
    expect(resolveCostRate(history, "u1", on("2026-05-05"))!.toString()).toBe("110");
  });

  it("includes the day a rate takes effect", () => {
    expect(resolveCostRate(history, "u1", on("2026-08-01"))!.toString()).toBe("120");
  });

  it("uses the prior rate the day before", () => {
    expect(resolveCostRate(history, "u1", on("2026-07-31"))!.toString()).toBe("110");
  });

  it("reaches the floored row for any older date", () => {
    expect(resolveCostRate(history, "u1", on("1999-01-01"))!.toString()).toBe("100");
  });

  it("is undefined for someone with no rows", () => {
    expect(resolveCostRate(history, "never", on("2026-08-01"))).toBeUndefined();
  });

  it("is undefined for someone absent entirely", () => {
    expect(resolveCostRate(history, "ghost", on("2026-08-01"))).toBeUndefined();
  });

  it("is undefined before the earliest rate, rather than falling back to it", () => {
    // The tempting fallback invents a cost for an hour nobody priced, and buries
    // it in a total that then looks complete.
    const late: CostRateHistory = new Map([
      ["u2", [{ effectiveFrom: on("2026-08-01"), costRate: D("90") }]],
    ]);
    expect(resolveCostRate(late, "u2", on("2026-07-31"))).toBeUndefined();
  });
});

describe("utcToday", () => {
  it("floors to UTC midnight so it compares against a DATE column", () => {
    expect(utcToday(new Date("2026-08-23T18:45:12.345Z")).toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("uses the UTC day even when the machine is not on UTC", () => {
    // This has to move the clock off UTC to mean anything: CI runs on UTC, where
    // local and UTC date parts agree and a local-parts implementation passes
    // every assertion while still being wrong on a developer's laptop.
    // Kiritimati is UTC+14, so 23:30Z is already tomorrow there.
    const prev = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      expect(utcToday(new Date("2026-08-23T23:30:00.000Z")).toISOString()).toBe(
        "2026-08-23T00:00:00.000Z",
      );
    } finally {
      process.env.TZ = prev;
    }
  });
});
