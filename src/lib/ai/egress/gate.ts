// src/lib/ai/egress/gate.ts
import { createHash } from "node:crypto";
import type { ClassificationLevel } from "@prisma/client";
import type { EgressContext, EgressResult, ProjectMeta } from "./types";

const ORDER: ClassificationLevel[] = ["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI", "CONFIDENTIAL"];
const rank = (l: ClassificationLevel) => ORDER.indexOf(l);
const FOUO = rank("FOUO");

export function sha256Hex(value: unknown): string {
  let s: string;
  try { s = typeof value === "string" ? value : JSON.stringify(value ?? null); }
  catch { s = "[unserializable]"; } // BigInt / circular — never throw out of the gate (no field-name leak)
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The MAC ceiling. Deterministic, fail-closed, DATA-CLASSIFICATION-driven (not tenant-driven):
 *  - system / user prompts          -> EXPOSE (non-data; prompt-gating is Phase 2).
 *  - data (tool_result/args/error):
 *      rank(ceiling) >= FOUO        -> WITHHOLD  (mandatory, BOTH tenants).
 *      else commercial              -> EXPOSE.
 *      else gov                     -> WITHHOLD  (default-deny; handles arrive in Phase 2).
 * The classifier (Phase 2) may only turn an EXPOSE into a WITHHOLD — never the reverse.
 */
export function projectForModel<T>(value: T, ctx: EgressContext, meta: ProjectMeta): EgressResult<T> {
  const contentHash = sha256Hex(value);
  const isData = meta.valueKind === "tool_result" || meta.valueKind === "tool_args" || meta.valueKind === "error";

  let exposed: boolean;
  let decidedBy: "rbac" | "agentpolicy" | "classification" | "tenant" | "none";
  if (!isData) { exposed = true; decidedBy = "none"; }
  else if (rank(meta.ceiling) >= FOUO) { exposed = false; decidedBy = "classification"; }
  else if (ctx.tenantClass === "commercial") { exposed = true; decidedBy = "none"; }
  else { exposed = false; decidedBy = "tenant"; }

  return {
    modelValue: exposed ? value : { withheld: true, ref: `withheld:${meta.valueKind}` },
    decision: {
      conversationId: ctx.conversationId, turn: ctx.turn, valueKind: meta.valueKind, toolName: meta.toolName,
      exposed, withheldCount: exposed ? 0 : 1, contentHash, decidedBy,
      tenantClass: ctx.tenantClass, mode: ctx.mode, ceiling: meta.ceiling,
    },
  };
}
