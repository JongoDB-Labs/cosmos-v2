import type { Budgets } from "./convergence";

export type LoopMode = "off" | "shadow" | "live";

export function coerceLoopMode(raw: string): LoopMode {
  return raw === "shadow" || raw === "live" ? raw : "off";
}

export interface LoopSettings {
  mode: LoopMode;
  budgets: Budgets;
}

/** Safe default: off, with budgets equal to the daemon's current hard caps. */
export function defaultLoopSettings(): LoopSettings {
  return {
    mode: "off",
    budgets: { wallClockMs: 90 * 60_000, costUsdCeiling: null, stallRounds: 3, maxAttempts: 3, maxTurnResumes: 30, maxIterations: 100 },
  };
}
