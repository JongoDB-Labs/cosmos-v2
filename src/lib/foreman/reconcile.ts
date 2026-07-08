import type { LedgerEntry } from "./ledger";

/** Gated ticket refs that have NOT since reached a terminal outcome — i.e. a
 *  `gated` entry with no later `shipped`/`duplicate`/`already-done` entry for the
 *  same ticket. These are the ones whose PR might now be merged + awaiting deploy.
 *
 *  Walk entries in order; a ticket is "pending gated" iff its LAST entry has
 *  resolution `"gated"` (a later `shipped`/`duplicate`/`already-done`/`needs-input`
 *  clears it). Returns the distinct refs, order-stable by first appearance. */
export function pendingGated(entries: LedgerEntry[]): string[] {
  const order: string[] = [];
  const lastResolution = new Map<string, LedgerEntry["resolution"]>();
  for (const e of entries) {
    if (!lastResolution.has(e.ticket)) order.push(e.ticket);
    lastResolution.set(e.ticket, e.resolution);
  }
  return order.filter((ref) => lastResolution.get(ref) === "gated");
}
