import type { Event, LoopState } from "./state";

/** Pure, deterministic state transition. Every transition increments iteration.
 *  Never mutates the input. This is the heart of the engine. */
export function reduce(state: LoopState, event: Event): LoopState {
  const base: LoopState = { ...state, iteration: state.iteration + 1 };
  switch (event.kind) {
    case "build_done": {
      const attempts = state.attempts + 1;
      const common = { ...base, sha: event.sha ?? base.sha, sessionRef: event.sessionRef, costUsd: base.costUsd + event.costUsd, attempts };
      return event.turnOverflow
        ? { ...common, turnResumes: state.turnResumes + 1, phase: "resuming" }
        : { ...common, phase: "checks" };
    }
    case "checks_done": {
      if (event.passed)
        return { ...base, lastCheckSignature: event.signature, noProgressRounds: 0, phase: "review" };
      const sameFailure = event.signature != null && event.signature === state.lastCheckSignature;
      return { ...base, lastCheckSignature: event.signature, noProgressRounds: sameFailure ? state.noProgressRounds + 1 : 0, phase: "repair" };
    }
    case "repair_done":
      return { ...base, sha: event.sha ?? base.sha, costUsd: base.costUsd + event.costUsd, phase: "checks" };
    case "review_done":
      return { ...base, phase: event.approved ? "shipping" : "repair" };
    case "shipped":
      return { ...base, phase: "done", terminationSignal: "shipped", terminationReason: `shipped ${event.version}` };
    case "parked":
      return { ...base, phase: "parked", terminationSignal: event.signal, terminationReason: event.reason };
    case "fatal":
      return { ...base, phase: "parked", terminationSignal: "fatal", terminationReason: event.reason };
  }
}
