import type { ReactNode } from "react";

/**
 * Narrow a recharts formatter argument to a usable Date, or null.
 *
 * recharts 3.10 widened `labelFormatter`'s parameter to `ReactNode` — which
 * includes `undefined`, booleans and elements — so passing it straight to
 * `new Date(...)` stopped compiling.
 *
 * The type error was the smaller half of the problem. `new Date(undefined)`
 * produces an Invalid Date, and `Invalid Date.toLocaleDateString()` renders the
 * literal text "Invalid Date" into the tooltip. That was reachable before this
 * bump; the compiler simply started pointing at it.
 *
 * Returns null for anything that is not a real point in time, so call sites
 * choose their own fallback instead of printing that string.
 */
export function toChartDate(value: ReactNode | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  // Reject booleans, elements, arrays and objects outright: `new Date(true)` is
  // 1970-01-01 rather than an error, which would be a plausible-looking wrong
  // answer — the worst kind.
  if (typeof value !== "string" && typeof value !== "number") return null;
  // Covers NaN, which is what a failed `Number(...)` coercion at a call site
  // produces (e.g. `Number(undefined)`).
  if (typeof value === "number" && !Number.isFinite(value)) return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
