// src/lib/ai/egress/types.ts
import type { ClassificationLevel } from "@prisma/client";

/** Tenant data-sensitivity class. Drives which paths/connectors are allowed. */
export type TenantClass = "gov" | "commercial";

/**
 * How the chokepoint authenticates to the model for THIS call. Resolved by the
 * egress layer (which has org context, via `@/lib/ai/ai-credentials`) and passed
 * BY VALUE into the stateless `provider.callModel` — the chokepoint never reads
 * org config itself. Lives here (the dependency-free types module) so the
 * resolver can reference it without importing the model-calling provider (which
 * the single-path arch test forbids outside `egress/`).
 *  - apiKey: a standard `sk-ant-api…` key → `x-api-key`.
 *  - oauth:  a Claude **subscription** access token (`sk-ant-oat…`) → Bearer + oauth beta.
 *  - openai: an OpenAI-COMPATIBLE endpoint (`baseURL` + key + model) — raw Chat
 *            Completions over fetch (NOT the Anthropic SDK).
 */
export type ModelCredential =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "oauth"; token: string }
  | { kind: "openai"; baseURL: string; apiKey: string; model: string };

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
  /**
   * Which gate withheld; "none" when exposed. "tenant" = gov fail-closed (P0).
   * The opaque-handle resolver adds three NON-"none" audit events (AC-4 evidence of
   * controlled CUI-by-reference movement / its enforcement, NOT the standard gate verdict):
   *   - "handle_mint":       N withheld CUI fields were minted as opaque handles for a
   *                          tool result (the model got tokens, never the values).
   *   - "handle_resolve":    N handles in a tool's args were resolved to real values
   *                          IN-BOUNDARY before the executor ran (allow path).
   *   - "handle_taint_block": a WRITE that resolved N handles minted at ceiling X was
   *                          REJECTED because its target context is cleared only below X
   *                          (write-path taint — would spill CUI into a lower-classification
   *                          container). The executor was NOT called; the CUI was never
   *                          written and never reached the model.
   * The D5 commercial-only gov-block adds two NON-"none" denial events (AC-3 evidence
   * that a commercial-only connector was refused to a gov tenant — defense in depth):
   *   - "connector_availability_block": the connector-registry DISPATCH layer refused a
   *                          commercial-only tool for a gov tenant (executeConnectorTool).
   *   - "connector_gov_block":          the connector EXECUTOR's own top-of-function gov
   *                          hard-check refused (the last in-code layer before the broker).
   * The GUI runtime-config (design §8) adds one NON-"none" denial event (evidence that a
   * connector the org DISABLED — or a breadth connector with breadthEnabled=false — was
   * refused at dispatch, defense in depth behind the tool-list filter):
   *   - "connector_disabled_block":     the connector-registry DISPATCH layer refused a tool
   *                          whose connector the org's runtime config disabled.
   * The DB column (egress_decisions.decided_by) is TEXT, so no migration is needed.
   */
  decidedBy: "rbac" | "agentpolicy" | "classification" | "tenant" | "none" | "handle_mint" | "handle_resolve" | "handle_taint_block" | "connector_availability_block" | "connector_gov_block" | "connector_disabled_block";
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
