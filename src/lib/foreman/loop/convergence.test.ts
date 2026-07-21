// @vitest-environment node
import { describe, it, expect } from "vitest";
import { classify, type Budgets } from "./convergence";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const B: Budgets = { wallClockMs: 60_000, costUsdCeiling: 5, stallRounds: 3, maxAttempts: 3, maxTurnResumes: 30, maxIterations: 100 };
const base = () => initialState("id", "o", brief, 0);

describe("classify", () => {
  it("is running for a fresh state within budget", () => {
    expect(classify({ ...base(), phase: "building" }, 1000, B).status).toBe("running");
  });
  it("returns budget_exhausted past the wall-clock", () => {
    expect(classify({ ...base(), phase: "building" }, 61_000, B)).toMatchObject({ status: "terminal", signal: "budget_exhausted" });
  });
  it("returns budget_exhausted past the cost ceiling", () => {
    expect(classify({ ...base(), phase: "building", costUsd: 6 }, 1000, B)).toMatchObject({ status: "terminal", signal: "budget_exhausted" });
  });
  it("returns iteration_cap at maxAttempts", () => {
    expect(classify({ ...base(), phase: "building", attempts: 3 }, 1000, B)).toMatchObject({ status: "terminal", signal: "iteration_cap" });
  });
  it("returns iteration_cap at maxTurnResumes", () => {
    expect(classify({ ...base(), phase: "resuming", turnResumes: 30 }, 1000, B)).toMatchObject({ status: "terminal", signal: "iteration_cap" });
  });
  it("returns iteration_cap at the hard maxIterations backstop (any-path termination)", () => {
    // A repair loop advancing NO other counter (distinct failures) still halts here.
    expect(classify({ ...base(), phase: "repair", iteration: 100 }, 1000, B)).toMatchObject({ status: "terminal", signal: "iteration_cap" });
  });
  it("returns stall once noProgressRounds hits stallRounds", () => {
    expect(classify({ ...base(), phase: "repair", noProgressRounds: 3 }, 1000, B)).toMatchObject({ status: "terminal", signal: "stall" });
  });
  it("surfaces an already-parked terminal state", () => {
    expect(classify({ ...base(), phase: "parked", terminationSignal: "parked_for_human", terminationReason: "needs input" }, 1000, B)).toMatchObject({ status: "terminal", signal: "parked_for_human" });
  });
  it("surfaces a shipped/done state", () => {
    expect(classify({ ...base(), phase: "done" }, 1000, B)).toMatchObject({ status: "terminal", signal: "shipped" });
  });
});
