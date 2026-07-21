import type { Event } from "./state";

export type DaemonSignal =
  | { kind: "built"; sha: string | null; sessionRef: string | null; turnOverflow: boolean }
  | { kind: "checks"; passed: boolean; signature: string | null }
  | { kind: "repaired"; sha: string | null }
  | { kind: "reviewed"; approved: boolean; reason: string }
  | { kind: "shipped"; version: string }
  | { kind: "parked"; humanReason: string }
  | { kind: "delivered_nooploop" }
  | { kind: "infra_failed"; reason: string };

/** Pure mapping from a daemon-emitted intent to an engine Event. Cost is 0 here
 *  (AgentResult exposes none). Returns the Event to fold via reduce(). */
export function translate(sig: DaemonSignal): Event | null {
  switch (sig.kind) {
    case "built":
      return { kind: "build_done", sha: sig.sha, sessionRef: sig.sessionRef, costUsd: 0, turnOverflow: sig.turnOverflow };
    case "checks":
      return { kind: "checks_done", passed: sig.passed, signature: sig.signature };
    case "repaired":
      return { kind: "repair_done", sha: sig.sha, costUsd: 0 };
    case "reviewed":
      return { kind: "review_done", approved: sig.approved, reason: sig.reason };
    case "shipped":
      return { kind: "shipped", version: sig.version };
    case "parked":
      return { kind: "parked", signal: "parked_for_human", reason: sig.humanReason };
    case "delivered_nooploop":
      return { kind: "shipped", version: "delivered" };
    case "infra_failed":
      return { kind: "fatal", reason: sig.reason };
  }
}
