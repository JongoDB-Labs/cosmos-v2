import { describe, it, expect } from "vitest";
import { matchesEstimateBand, hasAnyEstimate, ESTIMATE_BANDS } from "./estimate-filter";

const h = (n: number) => n * 3600;
const d = (n: number) => n * 8 * 3600; // working days — effort, not elapsed time

describe("matchesEstimateBand", () => {
  it("is inert on 'any'", () => {
    expect(matchesEstimateBand(h(2), "any")).toBe(true);
    expect(matchesEstimateBand(null, "any")).toBe(true);
  });

  it("finds unestimated work, and only that", () => {
    expect(matchesEstimateBand(null, "none")).toBe(true);
    expect(matchesEstimateBand(undefined, "none")).toBe(true);
    expect(matchesEstimateBand(h(2), "none")).toBe(false);
  });

  it("does not confuse a 0 estimate with no estimate", () => {
    // A deliberate zero says "no work expected"; absent says "nobody has said".
    // The same trap as story points, and the same `== null` guard.
    expect(matchesEstimateBand(0, "none")).toBe(false);
    expect(matchesEstimateBand(0, "lt4h")).toBe(true);
  });

  it("bands by working day, not by round numbers", () => {
    expect(matchesEstimateBand(h(3), "lt4h")).toBe(true);
    expect(matchesEstimateBand(h(4), "lt4h")).toBe(false);

    expect(matchesEstimateBand(h(4), "4to8h")).toBe(true);
    expect(matchesEstimateBand(h(8), "4to8h")).toBe(true);
    expect(matchesEstimateBand(h(9), "4to8h")).toBe(false);

    expect(matchesEstimateBand(h(9), "1to3d")).toBe(true);
    expect(matchesEstimateBand(d(3), "1to3d")).toBe(true);
    expect(matchesEstimateBand(d(3) + 1, "1to3d")).toBe(false);

    expect(matchesEstimateBand(d(4), "gt3d")).toBe(true);
    expect(matchesEstimateBand(d(3), "gt3d")).toBe(false);
  });

  it("leaves no gap between the bands", () => {
    // A value falling through every band would silently vanish from a filtered
    // board, which is the failure a reader cannot diagnose.
    const bands = ESTIMATE_BANDS.filter((b) => b.value !== "any" && b.value !== "none");
    for (const secs of [0, 1, h(3.99), h(4), h(8), h(8) + 1, d(3), d(3) + 1, d(10)]) {
      const hits = bands.filter((b) => matchesEstimateBand(secs, b.value));
      expect(hits.length, `${secs}s matched ${hits.length} bands`).toBe(1);
    }
  });

  it("offers no band the matcher does not understand", () => {
    for (const b of ESTIMATE_BANDS) {
      expect(() => matchesEstimateBand(h(5), b.value)).not.toThrow();
    }
  });
});

describe("hasAnyEstimate", () => {
  it("is false when nothing is estimated, so the control can hide", () => {
    expect(hasAnyEstimate([{ originalEstimate: null }, {}])).toBe(false);
    expect(hasAnyEstimate([])).toBe(false);
  });

  it("is true once anything is", () => {
    expect(hasAnyEstimate([{ originalEstimate: null }, { originalEstimate: h(2) }])).toBe(true);
  });

  it("counts a 0 estimate as an estimate", () => {
    expect(hasAnyEstimate([{ originalEstimate: 0 }])).toBe(true);
  });
});
