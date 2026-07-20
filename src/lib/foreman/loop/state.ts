import type { TicketBrief } from "@/lib/foreman/prompt";

export const SCHEMA_VERSION = 1;

/** Superset of the daemon's InFlightBuild phases plus lifecycle-terminal phases. */
export type Phase =
  | "queued" | "building" | "resuming" | "checks" | "repair"
  | "review" | "shipping" | "parked" | "done";

export type TerminationSignal =
  | "shipped" | "parked_for_human" | "stall"
  | "iteration_cap" | "budget_exhausted" | "fatal";

/** One invariant's outcome for a transition (see invariants.ts). */
export interface InvariantResult {
  id: string;
  ok: boolean;
  detail: string;
  remediation: string | null; // null when ok
}

/** What the driver should DO next — decideNext's output. Carries no IO payloads. */
export type Action =
  | { kind: "build" }
  | { kind: "resume" }
  | { kind: "run_checks" }
  | { kind: "repair" }
  | { kind: "review" }
  | { kind: "ship" }
  | { kind: "park"; signal: TerminationSignal; reason: string }
  | { kind: "noop" };

/** The OUTCOME of an executed action, fed into reduce(). */
export type Event =
  | { kind: "build_done"; sha: string | null; sessionRef: string | null; costUsd: number; turnOverflow: boolean }
  | { kind: "checks_done"; passed: boolean; signature: string | null }
  | { kind: "repair_done"; sha: string | null; costUsd: number }
  | { kind: "review_done"; approved: boolean; reason: string }
  | { kind: "shipped"; version: string }
  | { kind: "parked"; signal: TerminationSignal; reason: string }
  | { kind: "fatal"; reason: string };

/** Extracted, pruned facts a decision needs — observe.ts's output. */
export interface Observation {
  hasDiff: boolean;
  diffHash: string | null;
  checksPassed: boolean | null; // null = not run this iteration
  checkSignature: string | null;
  progressed: boolean;
  needsHumanInput: boolean;
}

/** The single typed, serializable, replayable per-ticket loop state. */
export interface LoopState {
  schemaVersion: number;
  loopId: string;
  orgId: string;
  brief: TicketBrief;
  phase: Phase;
  iteration: number;
  attempts: number;
  turnResumes: number;
  startedAtMs: number;
  sessionRef: string | null;
  worktreeRef: string | null;
  sha: string | null;
  lastDiffHash: string | null;
  lastCheckSignature: string | null;
  noProgressRounds: number;
  invariantResults: InvariantResult[];
  costUsd: number;
  terminationSignal: TerminationSignal | null;
  terminationReason: string | null;
}

export function initialState(loopId: string, orgId: string, brief: TicketBrief, nowMs: number): LoopState {
  return {
    schemaVersion: SCHEMA_VERSION,
    loopId, orgId, brief,
    phase: "queued",
    iteration: 0,
    attempts: 0,
    turnResumes: 0,
    startedAtMs: nowMs,
    sessionRef: null,
    worktreeRef: null,
    sha: null,
    lastDiffHash: null,
    lastCheckSignature: null,
    noProgressRounds: 0,
    invariantResults: [],
    costUsd: 0,
    terminationSignal: null,
    terminationReason: null,
  };
}

/** Explicit serialization seam (LoopState is already JSON-safe; this documents the boundary). */
export function serialize(state: LoopState): LoopState {
  return { ...state };
}

/** Load persisted state, running forward migrations to the current SCHEMA_VERSION. */
export function deserialize(raw: unknown): LoopState {
  const o = { ...(raw as Record<string, unknown>) };
  // Future: chain version migrations here when SCHEMA_VERSION advances.
  o.schemaVersion = SCHEMA_VERSION;
  return o as unknown as LoopState;
}

/** Deterministic, dependency-free djb2 hash -> hex. NEVER uses randomness (replay-safe). */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
