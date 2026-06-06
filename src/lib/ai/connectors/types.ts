// src/lib/ai/connectors/types.ts
//
// The declarative connector contract. A `ConnectorDescriptor` re-expresses, as
// DATA, the wiring an EXTERNAL connector (Google, GitHub, …) previously hand-spread
// across three files: its tool-name set + executor dispatch (tool-executor.ts), its
// tool schemas (tools.ts), and its egress mapping (egress/projection.ts —
// TOOL_ENTITY / EXPOSABLE_FIELDS / HANDLEABLE_FIELDS).
//
// ZERO-BEHAVIOR-CHANGE invariant: a descriptor only REFERENCES the existing tool
// defs + executor + egress entries — it never rewrites their logic. The registry
// (registry.ts) merges every descriptor's contributions back into the exact same
// shapes the rest of the system already consumes, so the effective tool list,
// dispatch, and egress maps are byte-identical to the pre-registry wiring.
//
// This is code ADJACENT to the CUI-blind egress chokepoint: the per-tool egress
// mapping a descriptor declares becomes the floor on what the model sees for that
// tool. An EMPTY egress map (Google) means NO TOOL_ENTITY ⇒ full withhold for a gov
// tenant — preserve that exactly.

import type { ToolDefinition } from "../tools";

/**
 * The execution context a connector executor receives. Mirrors the `ToolContext`
 * the central `executeTool` dispatcher already passes ({ orgId, userId }). A
 * descriptor's `execute` adapts this to its underlying executor's own context shape
 * (e.g. GitHub adds an optional injectable `fetchImpl` in tests; that stays internal
 * to its descriptor/executor and is NOT part of this shared contract).
 */
export interface ConnectorToolContext {
  orgId: string;
  userId: string;
}

/** Per-tool egress mapping a connector contributes → merged into TOOL_ENTITY. */
export interface ConnectorEgressEntry {
  /** The structural entity type for this tool's result (→ egress TOOL_ENTITY). */
  entityType: string;
}

/**
 * A single external connector, expressed declaratively.
 *
 * - `provider`        — stable id ('google' | 'github' | …); used in errors only.
 * - `toolDefs`        — the Anthropic tool schemas this connector contributes
 *                       (referenced verbatim from the existing tools/<provider>.ts).
 * - `execute`         — dispatch for THIS connector's own tools. The registry only
 *                       ever calls it for a name this descriptor owns, so it should
 *                       resolve every one of its tool names (a `null`/unknown return
 *                       is treated as "unhandled" by the registry — see registry.ts).
 * - `egress`          — per tool name → its egress entity mapping. The KEYS are the
 *                       tools whose results map to a structural entity type. A tool
 *                       ABSENT from this map (or an empty map entirely) ⇒ no
 *                       TOOL_ENTITY ⇒ full withhold for gov (Google's case).
 * - `exposableFields` — entity field allowlists this connector introduces (merged
 *                       into the global EXPOSABLE_FIELDS). Keyed by entityType.
 * - `handleableFields`— per-entity HANDLEABLE_FIELDS contributions (merged in).
 */
export interface ConnectorDescriptor {
  provider: string;
  toolDefs: ToolDefinition[];
  execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ConnectorToolContext,
  ): Promise<unknown>;
  egress: Record<string, ConnectorEgressEntry>;
  exposableFields?: Record<string, readonly string[]>;
  handleableFields?: Record<string, readonly string[]>;
}

/**
 * The merged egress contributions the registry derives from all descriptors. The
 * shapes match the static maps in egress/projection.ts exactly so they can be
 * spread together with the native entries to reconstruct the global maps unchanged.
 */
export interface ConnectorEgressMaps {
  /** tool name → entity type (merged into projection.ts TOOL_ENTITY). */
  toolEntity: Record<string, string>;
  /** entity type → exposable structural field allowlist (→ EXPOSABLE_FIELDS). */
  exposableFields: Record<string, readonly string[]>;
  /** entity type → handleable CUI-string field allowlist (→ HANDLEABLE_FIELDS). */
  handleableFields: Record<string, readonly string[]>;
}
