// src/lib/ai/egress/types.ts
import type { ClassificationLevel } from "@prisma/client";

/** Tenant data-sensitivity class. Drives which paths/connectors are allowed. */
export type TenantClass = "gov" | "commercial";

/** What kind of value is crossing the boundary toward the model. */
export type ValueKind = "system" | "user" | "tool_result" | "tool_args" | "error";

/** Phase 0 gate mode. Phase 1 adds real enforcement under "enforced". */
export type EgressMode = "passthrough" | "enforced";

export interface EgressContext {
  /** The org the request belongs to — lets callers resolve the ceiling; the gate ignores it. */
  orgId: string;
  conversationId: string;
  turn: number;
  tenantClass: TenantClass;
  mode: EgressMode;
}

/**
 * Logged for EVERY value the gate processes. NEVER contains CUI — only a
 * content hash + counts. This is the AC-4 information-flow evidence record;
 * Phase 1 persists it to the (append-only) AuditLog.
 */
export interface EgressDecision {
  conversationId: string;
  turn: number;
  valueKind: ValueKind;
  toolName?: string;
  exposed: boolean;
  /** Count of fields/values withheld (P0: 1 when any value is withheld; field-granular in Phase 1). */
  withheldCount: number;
  /** sha256 hex of the serialized value — tamper-evidence, not reversal. */
  contentHash: string;
  /** Which gate withheld; "none" when exposed. "tenant" = gov fail-closed (P0). */
  decidedBy: "rbac" | "agentpolicy" | "classification" | "tenant" | "none";
  tenantClass: TenantClass;
  mode: EgressMode;
  /** The data's effective classification ceiling at decision time (audit evidence). */
  ceiling?: string;
}

/** Input metadata for a single gate projection. */
export interface ProjectMeta {
  valueKind: ValueKind;
  toolName?: string;
  /** The value's effective classification ceiling (resolved by the caller). Required for data kinds. */
  ceiling: ClassificationLevel;
}

/** Placeholder substituted for a withheld value (an opaque reference in later phases). */
export interface WithheldRef {
  withheld: true;
  ref: string;
}

export interface EgressResult<T = unknown> {
  modelValue: T | WithheldRef;
  decision: EgressDecision;
}

export function isWithheld(v: unknown): v is WithheldRef {
  return typeof v === "object" && v !== null && (v as WithheldRef).withheld === true;
}
