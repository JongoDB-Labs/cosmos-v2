import { describe, it, expect } from "vitest";
import {
  KR_DEFAULT_TARGET,
  krFraction,
  krProgressPercent,
  measureKeyResult,
  objectiveProgressPercent,
  rollUpObjective,
} from "./progress";

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

describe("objectiveProgressPercent", () => {
  it("averages key results when the objective has any", () => {
    expect(objectiveProgressPercent([50, 100], 0, 0)).toBe(75);
  });

  it("IGNORES links when key results exist, so no existing number moves", () => {
    // The safety property of #52: an objective that already had KRs reports
    // exactly what it reported before, whatever gets linked to it.
    expect(objectiveProgressPercent([50, 100], 10, 0)).toBe(75);
    expect(objectiveProgressPercent([50, 100], 10, 10)).toBe(75);
    expect(objectiveProgressPercent([0], 4, 4)).toBe(0);
  });

  it("derives from linked delivery when there are no key results", () => {
    // Previously a hardcoded 0 forever — the gap this closes.
    expect(objectiveProgressPercent([], 4, 1)).toBe(25);
    expect(objectiveProgressPercent([], 3, 3)).toBe(100);
    expect(objectiveProgressPercent([], 3, 0)).toBe(0);
  });

  it("is still 0 with neither key results nor links", () => {
    expect(objectiveProgressPercent([], 0, 0)).toBe(0);
  });

  it("never exceeds 100 if done somehow outruns total", () => {
    expect(objectiveProgressPercent([], 2, 5)).toBe(100);
  });

  it("rounds to a whole percent", () => {
    expect(objectiveProgressPercent([], 3, 1)).toBe(33);
    expect(objectiveProgressPercent([], 6, 5)).toBe(83);
  });
});

describe("measureKeyResult — a key result counting linked work items", () => {
  const done = { completedAt: "2026-11-01T00:00:00Z" };
  const open = { completedAt: null };
  // What the OKR board's quick-add creates: a title, and the column defaults.
  const boardMade = { startValue: 0, currentValue: 0, targetValue: KR_DEFAULT_TARGET, lowerIsBetter: false };

  it("reads 3 / 3 and 100% when all three linked tickets are done (it read 3 / 100)", () => {
    const m = measureKeyResult(boardMade, [done, done, done]);
    expect([m.currentValue, m.targetValue, m.progress]).toEqual([3, 3, 100]);
    expect(m).toMatchObject({ autoTracked: true, targetFromLinks: true, linkedTotal: 3, linkedDone: 3 });
  });

  it("counts part-way: 1 of 3 done is 33%", () => {
    const m = measureKeyResult(boardMade, [done, open, open]);
    expect([m.currentValue, m.targetValue, m.progress]).toEqual([1, 3, 33]);
  });

  it("keeps a target someone set: 3 done against a target of 5 is 60%", () => {
    const m = measureKeyResult({ ...boardMade, targetValue: 5 }, [done, done, done]);
    expect([m.currentValue, m.targetValue, m.progress]).toEqual([3, 5, 60]);
    expect(m.targetFromLinks).toBe(false);
  });

  it("leaves a key result with no links on its stored numbers, default target included", () => {
    // A percentage key result: the default 100 is exactly what it means.
    const m = measureKeyResult({ ...boardMade, currentValue: 40 }, []);
    expect([m.currentValue, m.targetValue, m.progress]).toEqual([40, 100, 40]);
    expect(m).toMatchObject({ autoTracked: false, targetFromLinks: false, linkedTotal: 0 });
  });

  it("ignores the stored current value once tickets are linked", () => {
    const m = measureKeyResult({ ...boardMade, currentValue: 99 }, [open, open]);
    expect([m.currentValue, m.targetValue, m.progress]).toEqual([0, 2, 0]);
  });
});

describe("rollUpObjective", () => {
  it("averages measured key results, so a done linked KR rolls up as 100", () => {
    const kr = measureKeyResult(
      { startValue: 0, currentValue: 0, targetValue: KR_DEFAULT_TARGET, lowerIsBetter: false },
      [{ completedAt: new Date() }],
    );
    expect(rollUpObjective([kr, { progress: 50 }], []).progress).toBe(75);
  });

  it("speaks from the objective's own links only when it has no key results", () => {
    const linked = [{ completedAt: new Date() }, { completedAt: null }];
    expect(rollUpObjective([], linked)).toEqual({ progress: 50, autoTracked: true, linkedTotal: 2, linkedDone: 1 });
    expect(rollUpObjective([{ progress: 10 }], linked)).toMatchObject({ progress: 10, autoTracked: false });
  });
});
