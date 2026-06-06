// src/lib/ai/egress/gate.ts
import { createHash } from "node:crypto";
import type { EgressContext, EgressResult, ValueKind } from "./types";

export function sha256Hex(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  } catch {
    // Unserializable (circular ref, BigInt — e.g. OrgMember.permissions, etc.):
    // NEVER let this throw out of the gate. An exception would (a) crash the turn
    // before the withhold is logged and (b) can carry CUI *field names* in its
    // message. Hash a stable placeholder instead; the value is still withheld by
    // the projection caller, so no content reaches the model or the decision.
    s = "[unserializable]";
  }
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
      decidedBy: exposed ? "none" : "tenant",
      tenantClass: ctx.tenantClass,
      mode: ctx.mode,
    },
  };
}
