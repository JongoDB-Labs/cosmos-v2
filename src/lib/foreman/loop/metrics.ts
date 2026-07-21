/**
 * Pure convergence-metrics aggregation for the loop-graph eval harness (Phase 4).
 * Turns the raw ForemanLoopState projection + ForemanLoopTransition log into the
 * four convergence metrics the console dashboard reads: convergence-rate,
 * iterations-to-converge, invariant-violation-rate, cost-per-convergence. No IO —
 * the route fetches the rows and hands them here. Answers "is Foreman getting
 * better or worse at delivering?" — the prerequisite for scaling trust.
 */

/** One projection row (foreman_loop_state) — a loop's current/terminal status. */
export interface LoopStateRow {
  loopId: string;
  status: string; // "running" | a terminal signal (shipped/parked_for_human/stall/...)
  iteration: number;
}

/** One transition-log row (foreman_loop_transition). */
export interface LoopTransitionRow {
  loopId: string;
  iteration: number;
  toPhase: string;
  terminationSignal: string | null;
  invariantResults: unknown; // InvariantResult[] as stored JSON
  costUsd: number;
}

export interface LoopMetrics {
  totalLoops: number;
  running: number;
  terminal: number;
  /** shipped ÷ terminal loops. null when no loop has terminated yet. */
  convergenceRate: number | null;
  /** iteration count at which shipped loops converged. null when none shipped. */
  iterationsToConverge: { mean: number; p50: number } | null;
  /** transitions carrying a failing invariant ÷ total transitions. null when none. */
  invariantViolationRate: number | null;
  /** total recorded cost ÷ shipped loops. null when none shipped. (0 until cost is sourced.) */
  costPerConvergence: number | null;
  /** count of loops per terminal signal (excludes "running"). */
  bySignal: Record<string, number>;
}

const SHIPPED = "shipped";

function hasFailingInvariant(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((r) => r && typeof r === "object" && (r as { ok?: unknown }).ok === false);
}

function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeLoopMetrics(states: LoopStateRow[], transitions: LoopTransitionRow[]): LoopMetrics {
  const totalLoops = states.length;
  const running = states.filter((s) => s.status === "running").length;
  const terminal = totalLoops - running;

  const bySignal: Record<string, number> = {};
  for (const s of states) {
    if (s.status === "running") continue;
    bySignal[s.status] = (bySignal[s.status] ?? 0) + 1;
  }

  const shipped = states.filter((s) => s.status === SHIPPED);
  const shippedCount = shipped.length;

  const convergenceRate = terminal > 0 ? shippedCount / terminal : null;

  const iterationsToConverge =
    shippedCount > 0
      ? {
          mean: shipped.reduce((a, s) => a + s.iteration, 0) / shippedCount,
          p50: p50(shipped.map((s) => s.iteration)),
        }
      : null;

  const invariantViolationRate =
    transitions.length > 0
      ? transitions.filter((t) => hasFailingInvariant(t.invariantResults)).length / transitions.length
      : null;

  const totalCost = transitions.reduce((a, t) => a + (Number.isFinite(t.costUsd) ? t.costUsd : 0), 0);
  const costPerConvergence = shippedCount > 0 ? totalCost / shippedCount : null;

  return {
    totalLoops,
    running,
    terminal,
    convergenceRate,
    iterationsToConverge,
    invariantViolationRate,
    costPerConvergence,
    bySignal,
  };
}
