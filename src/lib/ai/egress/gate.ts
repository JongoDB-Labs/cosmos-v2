// src/lib/ai/egress/gate.ts
import { createHash } from "node:crypto";
import type { EgressContext, EgressResult, ValueKind } from "./types";

export function sha256Hex(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Phase 0 projection: the seam, not the enforcement.
 *  - commercial + passthrough  -> expose verbatim (the agent works today).
 *  - gov (any mode)            -> WITHHOLD (fail-closed). Gov has no live model
 *    path until Phase 1 ships the classification gate; encoding the deny here
 *    makes the invariant testable from day one.
 * Phase 1 replaces the boolean with RBAC ∩ AgentPolicy ∩ Classification and a
 * deterministic field-level default-deny floor under the classifier.
 */
export function projectForModel<T>(
  value: T,
  ctx: EgressContext,
  meta: { valueKind: ValueKind; toolName?: string },
): EgressResult<T> {
  const contentHash = sha256Hex(value);
  const exposed = ctx.tenantClass === "commercial" && ctx.mode === "passthrough";
  return {
    modelValue: exposed ? value : { withheld: true, ref: `withheld:${meta.valueKind}` },
    decision: {
      conversationId: ctx.conversationId,
      turn: ctx.turn,
      valueKind: meta.valueKind,
      toolName: meta.toolName,
      exposed,
      withheldCount: exposed ? 0 : 1,
      contentHash,
      decidedBy: exposed ? "none" : "classification",
      tenantClass: ctx.tenantClass,
      mode: ctx.mode,
    },
  };
}
