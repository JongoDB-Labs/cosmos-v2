import type { Action, LoopState, Observation } from "./state";

/** Pure decision of the next action given current phase + observation.
 *  The driver executes the Action's IO; this function chooses only. */
export function decideNext(state: LoopState, obs: Observation): Action {
  if (obs.needsHumanInput) return { kind: "park", signal: "parked_for_human", reason: "needs human input" };
  switch (state.phase) {
    case "queued":
      return { kind: "build" };
    case "building":
      return { kind: "run_checks" };
    case "resuming":
      return { kind: "run_checks" };
    case "checks":
      if (obs.checksPassed === true) return { kind: "review" };
      if (obs.checksPassed === false) return { kind: "repair" };
      return { kind: "run_checks" };
    case "repair":
      return { kind: "run_checks" };
    case "review":
      return { kind: "ship" };
    case "shipping":
    case "done":
    case "parked":
    default:
      return { kind: "noop" };
  }
}
