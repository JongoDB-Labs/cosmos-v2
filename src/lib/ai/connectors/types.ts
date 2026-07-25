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
// Type-only import straight from the egress TYPES module (not its index) to avoid
// dragging the egress runtime graph into the connector type layer — and `import type`
// is erased at compile time, so there is no runtime interval either way.
import type { TenantClass } from "../egress/types";

/**
 * A connector's tenant AVAILABILITY — the D5 gov-block axis.
 *  - "all"             — available to BOTH tenant classes (Google, GitHub: native
 *                        top-N behind our own fence; unchanged behavior).
 *  - "commercial-only" — available to COMMERCIAL tenants ONLY. A gov tenant must
 *                        NEVER see its tools, reach its executor, or get a connection.
 *                        This is the load-bearing control for COMMERCIAL-breadth
 *                        connectors (Nango): commercial-only by construction.
 * Default (when a descriptor omits it) is "all" — every existing connector keeps
 * its exact behavior; only an explicitly commercial-only connector is gov-blocked.
 */
export type ConnectorAvailability = "all" | "commercial-only";

/** Re-exported so connector consumers don't reach into the egress layer directly. */
export type { TenantClass };

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
  /**
   * The org's data-sensitivity class (D5 gov-block axis). The dispatcher threads it
   * through so `executeConnectorTool` can hard-refuse a `commercial-only` tool for a
   * gov tenant (defense-in-depth LAYER 2). OPTIONAL for backward compatibility — when
   * absent, a commercial-only tool is refused (fail closed toward the gov rule).
   */
  tenantClass?: TenantClass;
  /** Conversation id for the L2 refusal audit record (egress-decision trail). */
  conversationId?: string;
  /**
   * The org's per-org RUNTIME ENABLEMENT (design §8 GUI runtime-config). The dispatcher
   * threads it through so `executeConnectorTool` can hard-refuse a tool whose connector
   * the org has DISABLED (or a breadth connector when breadthEnabled=false) — defense in
   * depth behind the tool-list filter. OPTIONAL: absent ⇒ no extra narrowing (today's
   * behavior). Shape mirrors {@link ConnectorEnabledFilter} in registry.ts.
   */
  enabled?: {
    enabledConnectors?: string[] | null;
    breadthEnabled?: boolean;
  };
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
  /**
   * Tenant availability — the D5 gov-block axis. DEFAULT "all" (omit for the native
   * top-N: Google/GitHub). Set "commercial-only" to make a connector unreachable to
   * gov tenants at EVERY layer (tool-list filter, dispatch refusal, executor check,
   * connect route). See {@link ConnectorAvailability}.
   */
  availability?: ConnectorAvailability;
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
