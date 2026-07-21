import type { Action, LoopState, Observation } from "./state";

/** Pure decision of the next action for the current phase. The topology is:
 *  reduce() owns ROUTING (events move the phase), decideNext() maps each phase to
 *  the ONE IO action that advances it — a strict 1:1, no result-inspection here.
 *  (The pass/fail branch lives in reduce's `checks_done`, not here.) */
export function decideNext(state: LoopState, obs: Observation): Action {
  if (obs.needsHumanInput) return { kind: "park", signal: "parked_for_human", reason: "needs human input" };
  switch (state.phase) {
    case "queued":
      return { kind: "build" };
    case "building":
      // Driver-only transient (reduce never sets it); fall through to checks.
      return { kind: "run_checks" };
    case "resuming":
      return { kind: "resume" };
    case "checks":
      return { kind: "run_checks" };
    case "repair":
      return { kind: "repair" };
    case "review":
      return { kind: "review" };
    case "shipping":
      return { kind: "ship" };
    case "done":
    case "parked":
    default:
      return { kind: "noop" };
  }
}
