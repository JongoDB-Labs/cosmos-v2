import { describe, it, expect } from "vitest";
import { krFraction, krProgressPercent, objectiveProgressPercent } from "./progress";

describe("krFraction — higher-is-better (default)", () => {
  it("is 0 at start, 1 at target, 0.5 halfway", () => {
    expect(krFraction(0, 0, 100)).toBe(0);
    expect(krFraction(0, 100, 100)).toBe(1);
    expect(krFraction(0, 50, 100)).toBe(0.5);
  });

  it("clamps below start and above target", () => {
    expect(krFraction(0, -20, 100)).toBe(0);
    expect(krFraction(0, 140, 100)).toBe(1);
  });

  it("handles a non-zero start", () => {
    expect(krFraction(20, 60, 100)).toBeCloseTo(0.5, 5);
  });

  it("returns 1 when start === target and value has reached it, else 0", () => {
    expect(krFraction(100, 100, 100)).toBe(1);
    expect(krFraction(100, 90, 100)).toBe(0);
  });
});

describe("krFraction — lower-is-better (descending baseline → goal)", () => {
  it("0 at start, 1 at target, 0.5 halfway when the goal is below the baseline", () => {
    // e.g. latency: baseline 200ms → goal 100ms
    expect(krFraction(200, 200, 100, true)).toBe(0);
    expect(krFraction(200, 100, 100, true)).toBe(1);
    expect(krFraction(200, 150, 100, true)).toBe(0.5);
  });

  it("a value WORSE than the baseline (higher latency) clamps to 0, not 100%", () => {
    expect(krFraction(200, 260, 100, true)).toBe(0);
  });

  it("a value past the goal clamps to 1", () => {
    expect(krFraction(200, 80, 100, true)).toBe(1);
  });

  it("disambiguates the degenerate start === target case (win = at/under target)", () => {
    expect(krFraction(100, 100, 100, true)).toBe(1);
    expect(krFraction(100, 120, 100, true)).toBe(0);
    // ...and this is the ONLY case where the flag changes the result:
    expect(krFraction(100, 120, 100, false)).toBe(1); // higher-is-better: 120 ≥ 100 → done
    expect(krFraction(100, 120, 100, true)).toBe(0); // lower-is-better: 120 > 100 → not done
  });
});

describe("krFraction — the flag does NOT change the number for real ranges", () => {
  // The formula is direction-agnostic once start=baseline and target=goal are set
  // correctly; lowerIsBetter is metadata, not a different computation. This guards
  // against anyone "fixing" progress by toggling the flag instead of the values.
  it.each([
    [200, 150, 100],
    [200, 260, 100],
    [500, 450, 200],
    [0, 95, 100],
    [100, 50, 0],
  ])("start=%i current=%i target=%i is identical either way", (s, c, t) => {
    expect(krFraction(s, c, t, true)).toBe(krFraction(s, c, t, false));
  });
});

describe("krProgressPercent", () => {
  it("rounds the fraction to a whole percent", () => {
    expect(krProgressPercent(0, 50, 100)).toBe(50);
    expect(krProgressPercent(0, 1, 3)).toBe(33);
  });

  it("mirrors for lower-is-better", () => {
    expect(krProgressPercent(200, 150, 100, true)).toBe(50);
    expect(krProgressPercent(200, 260, 100, true)).toBe(0);
  });
});

describe("objectiveProgressPercent — folds direct work-item links into the roll-up", () => {
  it("with no direct links, equals the plain key-result average", () => {
    expect(objectiveProgressPercent([100, 0], 0, 0)).toBe(50);
    expect(objectiveProgressPercent([40, 60, 80], 0, 0)).toBe(60);
  });

  it("with no key results, is the share of linked items that are done", () => {
    expect(objectiveProgressPercent([], 4, 1)).toBe(25);
    expect(objectiveProgressPercent([], 2, 2)).toBe(100);
    expect(objectiveProgressPercent([], 3, 0)).toBe(0);
  });

  it("averages key results and direct links together as equal units", () => {
    // one KR at 100% + two direct items (one done) → (100 + 100 + 0) / 3 = 67
    expect(objectiveProgressPercent([100], 2, 1)).toBe(67);
  });

  it("is 0 when there are no units at all", () => {
    expect(objectiveProgressPercent([], 0, 0)).toBe(0);
  });

  it("never exceeds 100% even if done is over-reported", () => {
    expect(objectiveProgressPercent([], 2, 5)).toBe(100);
  });
});
