// src/lib/ai/egress/audit.ts
import type { EgressDecision } from "./types";

/**
 * Phase 0: emit the decision as one structured stdout line (no CUI in it).
 * Phase 1 swaps this to write an append-only AuditLog/EgressDecision row
 * (AU-2/3/12 + AC-4 evidence). Keep the call sites stable so that swap is
 * internal to this function.
 */
export function logEgressDecision(d: EgressDecision): void {
   
  console.info(`[egress] ${JSON.stringify(d)}`);
}
