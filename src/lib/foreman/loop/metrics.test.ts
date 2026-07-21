// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeLoopMetrics, type LoopStateRow, type LoopTransitionRow } from "./metrics";

const st = (loopId: string, status: string, iteration: number): LoopStateRow => ({ loopId, status, iteration });
const tr = (loopId: string, iteration: number, over: Partial<LoopTransitionRow> = {}): LoopTransitionRow => ({
  loopId, iteration, toPhase: "checks", terminationSignal: null, invariantResults: [], costUsd: 0, ...over,
});

describe("computeLoopMetrics", () => {
  it("returns null metrics for an empty set", () => {
    const m = computeLoopMetrics([], []);
    expect(m).toMatchObject({ totalLoops: 0, running: 0, terminal: 0, convergenceRate: null, iterationsToConverge: null, invariantViolationRate: null, costPerConvergence: null, bySignal: {} });
  });

  it("computes convergence-rate as shipped ÷ terminal (excludes running)", () => {
    const states = [st("a", "shipped", 4), st("b", "parked_for_human", 2), st("c", "shipped", 6), st("d", "running", 1)];
    const m = computeLoopMetrics(states, []);
    expect(m.totalLoops).toBe(4);
    expect(m.running).toBe(1);
    expect(m.terminal).toBe(3);
    expect(m.convergenceRate).toBeCloseTo(2 / 3);
    expect(m.bySignal).toEqual({ shipped: 2, parked_for_human: 1 });
  });

  it("computes iterations-to-converge (mean + p50) over shipped loops only", () => {
    const states = [st("a", "shipped", 4), st("b", "shipped", 6), st("c", "shipped", 8), st("d", "stall", 99)];
    const m = computeLoopMetrics(states, []);
    expect(m.iterationsToConverge).toEqual({ mean: 6, p50: 6 });
  });

  it("computes invariant-violation-rate from transitions with a failing invariant", () => {
    const transitions = [
      tr("a", 1, { invariantResults: [{ id: "x", ok: true }] }),
      tr("a", 2, { invariantResults: [{ id: "y", ok: false }] }),
      tr("b", 1, { invariantResults: [] }),
      tr("b", 2, { invariantResults: "garbage" }),
    ];
    const m = computeLoopMetrics([], transitions);
    expect(m.invariantViolationRate).toBeCloseTo(1 / 4);
  });

  it("computes cost-per-convergence as total cost ÷ shipped loops", () => {
    const states = [st("a", "shipped", 3), st("b", "shipped", 5)];
    const transitions = [tr("a", 1, { costUsd: 2 }), tr("a", 2, { costUsd: 1 }), tr("b", 1, { costUsd: 3 })];
    const m = computeLoopMetrics(states, transitions);
    expect(m.costPerConvergence).toBeCloseTo(6 / 2);
  });

  it("leaves rate/cost null when no loop has terminated / shipped", () => {
    const m = computeLoopMetrics([st("a", "running", 0)], [tr("a", 1)]);
    expect(m.convergenceRate).toBeNull();
    expect(m.iterationsToConverge).toBeNull();
    expect(m.costPerConvergence).toBeNull();
    expect(m.invariantViolationRate).toBe(0); // 1 transition, 0 violations
  });
});
