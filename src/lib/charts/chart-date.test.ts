import { describe, it, expect } from "vitest";
import { toChartDate } from "./chart-date";

// recharts 3.10 widened `labelFormatter`'s parameter to ReactNode, which
// includes undefined, booleans and elements. The old code fed it straight to
// `new Date(...)`:
//
//   labelFormatter={(val) => new Date(val).toLocaleDateString(...)}
//
// That stopped compiling — but it was already capable of rendering the string
// "Invalid Date" into a tooltip whenever the label was missing. Narrowing the
// value fixes the type error and that display bug in the same move.
describe("toChartDate", () => {
  it("accepts an ISO date string", () => {
    expect(toChartDate("2026-07-30")?.getUTCFullYear()).toBe(2026);
  });

  it("accepts epoch milliseconds", () => {
    expect(toChartDate(1753833600000)?.getTime()).toBe(1753833600000);
  });

  it("accepts a Date and returns an equal value", () => {
    const d = new Date("2026-07-30T00:00:00Z");
    expect(toChartDate(d)?.getTime()).toBe(d.getTime());
  });

  it("returns null for undefined rather than an Invalid Date", () => {
    // The actual regression: `new Date(undefined)` yields an Invalid Date whose
    // toLocaleDateString() renders the literal text "Invalid Date" in the UI.
    expect(toChartDate(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(toChartDate(null)).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(toChartDate("not a date")).toBeNull();
  });

  it("returns null for NaN, which is what a failed Number() coercion produces", () => {
    // kpis-dashboard calls Number(label) before this; Number(undefined) is NaN.
    expect(toChartDate(Number(undefined))).toBeNull();
  });

  it("returns null for a boolean or an object, which ReactNode permits", () => {
    expect(toChartDate(true)).toBeNull();
    expect(toChartDate({} as never)).toBeNull();
  });
});
