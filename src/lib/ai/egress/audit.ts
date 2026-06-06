// src/lib/ai/egress/audit.ts
import { prisma } from "@/lib/db/client";
import type { EgressDecision } from "./types";

/**
 * Persist the decision (hashes/counts, never CUI) to the append-only egress_decisions
 * table — the AC-4 information-flow evidence trail. Fire-and-forget: a logging failure
 * must never block or crash the agent turn.
 */
export function logEgressDecision(d: EgressDecision): void {
  void prisma.egressDecisionRow
    .create({
      data: {
        conversationId: d.conversationId, turn: d.turn, valueKind: d.valueKind,
        toolName: d.toolName, exposed: d.exposed, withheldCount: d.withheldCount,
        contentHash: d.contentHash, decidedBy: d.decidedBy, tenantClass: d.tenantClass,
        ceiling: d.ceiling,
      },
    })
    .catch((e: unknown) => console.warn("[egress] decision persist failed:", (e as Error).message));
}
