import { hashString, type LoopState, type Observation } from "./state";

/** Raw facts the driver gathers via IO and hands to the pure observer. */
export interface RawFacts {
  diff: string | null;          // current working diff (null = none)
  checksPassed: boolean | null; // null = checks not run this iteration
  checkLog: string | null;      // check output when run
  needsHumanInput: boolean;     // a clarity/approval gate fired
}

/** Extract + prune facts into an Observation, computing progress vs. last iteration
 *  for stall detection. Pure: no IO, deterministic. */
export function observe(state: LoopState, facts: RawFacts): Observation {
  const diffHash = facts.diff ? hashString(facts.diff) : null;
  const checkSignature = facts.checkLog ? hashString(normalizeLog(facts.checkLog)) : null;
  const progressed = diffHash !== state.lastDiffHash || checkSignature !== state.lastCheckSignature;
  return {
    hasDiff: !!facts.diff,
    diffHash,
    checksPassed: facts.checksPassed,
    checkSignature,
    progressed,
    needsHumanInput: facts.needsHumanInput,
  };
}

/** Reduce a check log to its failure identity: keep error-ish lines, drop volatile
 *  noise (timestamps, path line/col) so the same failure hashes stably. */
function normalizeLog(log: string): string {
  return log
    .split("\n")
    .filter((l) => /error|fail|✕|✗|expected|assert/i.test(l))
    .map((l) => l.replace(/:\d+:\d+/g, "").replace(/\d{2}:\d{2}:\d{2}/g, "").trim())
    .join("\n");
}
