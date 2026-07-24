import type { Candidate } from "@/lib/dedup/dedup";
import type { LedgerEntry } from "./ledger";

/** Prior resolved tickets from Foreman's ledger become dedup candidates. Lives with
 *  Foreman (it is coupled to the ledger's resolution vocabulary); the generic dedup
 *  gate + prefilter are core (@/lib/dedup). */
export function ledgerCandidates(entries: LedgerEntry[]): Candidate[] {
  return entries
    .filter((e) => e.resolution === "shipped" || e.resolution === "gated" || e.resolution === "already-done")
    .map((e) => ({ ref: e.ticket, title: e.title }));
}
