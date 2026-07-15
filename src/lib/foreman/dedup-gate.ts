import { excludeFamily, prefilter, type Candidate } from "./dedup";
import type { LedgerEntry } from "./ledger";

export interface DedupInput {
  title: string;
  candidates: Candidate[];
  /** Ref of this ticket's parent epic, when it is a decomposition child. The gate
   *  excludes the parent epic and its sibling children from the candidate set —
   *  decomposition children are narrower scopes of the parent, not duplicates. */
  parentRef?: string | null;
}

/** The semantic decision — injected so the pure gate is unit-testable and the
 *  real judge (a subscription `claude -p` call) lives in the orchestrator. */
export type Judge = (
  title: string,
  shortlist: Candidate[],
) => Promise<{ dupOf: string | null; reason: string }>;

/** Cheap prefilter first; only consult the (costly) judge on plausible matches. */
export async function dedupGate(
  input: DedupInput,
  judge: Judge,
  threshold = 0.5,
): Promise<{ dupOf: string | null; reason: string }> {
  const eligible = excludeFamily(input.parentRef, input.candidates);
  const shortlist = prefilter(input.title, eligible, threshold);
  if (shortlist.length === 0) return { dupOf: null, reason: "no similar prior work" };
  return judge(input.title, shortlist);
}

/** Prior resolved tickets from the ledger become dedup candidates. */
export function ledgerCandidates(entries: LedgerEntry[]): Candidate[] {
  return entries
    .filter((e) => e.resolution === "shipped" || e.resolution === "gated" || e.resolution === "already-done")
    .map((e) => ({ ref: e.ticket, title: e.title }));
}
