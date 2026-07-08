import { appendFileSync, readFileSync, existsSync } from "node:fs";

export type Resolution = "shipped" | "gated" | "duplicate" | "already-done" | "needs-input";

export interface LedgerEntry {
  ticket: string;
  title: string;
  classification: "BUG" | "FEATURE";
  resolution: Resolution;
  version?: string;
  dupOf?: string;
  ts: string; // ISO
}

/** Append one durable outcome line. The ledger is the authoritative history,
 *  independent of anyone moving cards on the board. */
export function appendLedger(path: string, entry: LedgerEntry): void {
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/** Read all entries; missing file → []; malformed lines are skipped, not fatal. */
export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as LedgerEntry);
    } catch {
      /* skip a corrupt line rather than fail the run */
    }
  }
  return out;
}
