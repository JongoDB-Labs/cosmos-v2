import type { LoopState, TerminationSignal } from "./state";

export interface Budgets {
  wallClockMs: number;
  costUsdCeiling: number | null;
  stallRounds: number;
  maxAttempts: number;
  maxTurnResumes: number;
}

export interface Verdict {
  status: "running" | "terminal";
  signal?: TerminationSignal;
  reason: string;
}

/** The single convergence contract. Replaces the scattered
 *  MAX_ATTEMPTS / MAX_TURN_RESUMES / BUILD_BUDGET_MS / breaker checks. */
export function classify(state: LoopState, now: number, b: Budgets): Verdict {
  if (state.phase === "done")
    return { status: "terminal", signal: "shipped", reason: state.terminationReason ?? "shipped" };
  if (state.phase === "parked")
    return { status: "terminal", signal: state.terminationSignal ?? "parked_for_human", reason: state.terminationReason ?? "parked" };

  if (now - state.startedAtMs > b.wallClockMs)
    return { status: "terminal", signal: "budget_exhausted", reason: `wall-clock ${Math.round((now - state.startedAtMs) / 60_000)}m exceeded budget` };
  if (b.costUsdCeiling != null && state.costUsd > b.costUsdCeiling)
    return { status: "terminal", signal: "budget_exhausted", reason: `cost $${state.costUsd.toFixed(2)} exceeded ceiling $${b.costUsdCeiling.toFixed(2)}` };

  if (state.attempts >= b.maxAttempts)
    return { status: "terminal", signal: "iteration_cap", reason: `${state.attempts} attempts (cap ${b.maxAttempts})` };
  if (state.turnResumes >= b.maxTurnResumes)
    return { status: "terminal", signal: "iteration_cap", reason: `${state.turnResumes} turn-resumes (cap ${b.maxTurnResumes})` };

  if (state.noProgressRounds >= b.stallRounds)
    return { status: "terminal", signal: "stall", reason: `no progress across ${state.noProgressRounds} rounds` };

  return { status: "running", reason: "converging" };
}
