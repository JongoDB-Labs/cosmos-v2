// src/lib/ai/egress/audit.ts
import { prisma } from "@/lib/db/client";
import { recordEgressDecision } from "@/lib/observability/metrics";
import type { EgressDecision } from "./types";

/**
 * Persist the decision (hashes/counts, never CUI) to the append-only egress_decisions
 * table — the AC-4 information-flow evidence trail. Fire-and-forget: a logging failure
 * must never block or crash the agent turn.
 */
export function logEgressDecision(d: EgressDecision): void {
  // OBSERVE-ONLY metric (SI-4): emit a counter increment with LOW-CARDINALITY ENUMS only
  // (exposed / decidedBy / tenantClass) — never the conversationId, content, or hash.
  // recordEgressDecision() is itself fire-and-forget (never throws); this does not change
  // any gate decision and must not block the persist below.
  recordEgressDecision({ exposed: d.exposed, decidedBy: d.decidedBy, tenantClass: d.tenantClass });
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
