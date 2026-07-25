// src/lib/ai/connectors/registry.ts
//
// The connector registry: the single place external connectors register, and the
// single source the rest of the system derives its connector wiring from. It turns
// a set of `ConnectorDescriptor`s into the exact shapes the loop / dispatcher /
// egress layer already consume:
//   - connectorToolDefs()    → the tool schemas to append to the model tool list.
//   - connectorToolNames()   → the O(1) membership set the dispatcher checks.
//   - executeConnectorTool() → routes a call to its OWNING descriptor.
//   - connectorEgressMaps()  → merged TOOL_ENTITY / EXPOSABLE_FIELDS /
//                              HANDLEABLE_FIELDS contributions.
//
// HARD INVARIANTS (fail LOUDLY at registration — a silent collision could change
// dispatch or egress for an existing tool):
//   1. No two descriptors may declare the SAME tool name (ambiguous dispatch).
//   2. No two descriptors may declare the same provider id (double-registration).
//   3. A tool listed in a descriptor's `egress` map MUST be one of that descriptor's
//      own tool names (a stray egress key would silently widen the global map).
// The derived accessors recompute from the live descriptor list on every call, so
// they always reflect exactly what is registered — no stale snapshot.

import type {
  ConnectorDescriptor,
  ConnectorEgressMaps,
  ConnectorToolContext,
  TenantClass,
} from "./types";
// Import the audit + hash helpers DIRECTLY from their leaf modules (NOT the egress
// index) so registry.ts doesn't pull egress/projection.ts → connectors/index.ts back
// into itself (a runtime import interval). audit.ts / gate.ts have no ../connectors edge.
import { logEgressDecision } from "../egress/audit";
import { sha256Hex } from "../egress/gate";

/** Is this descriptor reachable by the given tenant class? (D5 gov-block axis.) */
function isAvailableTo(d: ConnectorDescriptor, tenantClass: TenantClass | undefined): boolean {
  // "commercial-only" is blocked for gov; "all" (or unset) is available to both.
  // When tenantClass is undefined (a non-tenant-scoped caller), be PERMISSIVE only
  // for "all" and STILL block "commercial-only" — fail closed toward the gov rule.
  if ((d.availability ?? "all") === "commercial-only") {
    return tenantClass === "commercial";
  }
  return true;
}

/**
 * The per-org RUNTIME ENABLEMENT filter (design §8 GUI runtime-config). ADDITIVE on top of
 * the tenantClass/availability rule — it never WIDENS access, only narrows it further.
 *  - `enabledConnectors`: provider allowlist, or `null`/`undefined` for "all enabled"
 *    (the DEFAULT — preserves current behavior). An explicit array opts into a SUBSET.
 *  - `breadthEnabled`: the Nango/commercial-breadth toggle. When false, every BREADTH
 *    connector (availability:"commercial-only") is hidden/refused even for commercial.
 *    `undefined` ⇒ true (default-on). (Gov never reaches breadth regardless — the
 *    availability rule above already blocks it.)
 * OMITTING the whole filter ⇒ no extra narrowing (today's behavior). This is the object
 * `getRuntimeConfig()` produces (minus mcpEnabled, which isn't a connector axis yet).
 */
export interface ConnectorEnabledFilter {
  enabledConnectors?: string[] | null;
  breadthEnabled?: boolean;
}

/** Is a descriptor a BREADTH (commercial-only) connector — the Nango case the breadth
 *  toggle governs? Today's only breadth connector is Nango (availability:"commercial-only"). */
function isBreadthConnector(d: ConnectorDescriptor): boolean {
  return (d.availability ?? "all") === "commercial-only";
}

/**
 * Apply the per-org runtime enablement filter to a descriptor. A descriptor passes only if
 * BOTH hold:
 *   1. provider ∈ enabledConnectors  OR  enabledConnectors is null/undefined (= all enabled);
 *   2. it is NOT a breadth connector  OR  breadthEnabled is true.
 * (The tenantClass/availability rule is applied SEPARATELY by the callers; this is purely
 * the org-runtime narrowing.) Omitting `filter` ⇒ always true (no extra narrowing).
 */
function isEnabledByConfig(d: ConnectorDescriptor, filter?: ConnectorEnabledFilter): boolean {
  if (!filter) return true;
  const allowlist = filter.enabledConnectors;
  if (allowlist != null && !allowlist.includes(d.provider)) return false;
  const breadthOn = filter.breadthEnabled ?? true;
  if (isBreadthConnector(d) && !breadthOn) return false;
  return true;
}

/** The live set of registered descriptors, keyed by provider for dup-detection. */
const descriptors: ConnectorDescriptor[] = [];
/** tool name → owning descriptor, the dispatch index (rebuilt on each register). */
const toolNameOwner = new Map<string, ConnectorDescriptor>();

/**
 * Register a connector. Validates the cross-descriptor invariants and fails LOUDLY
 * (throws) on any collision — a duplicate tool name, duplicate provider, or an
 * egress key that isn't one of this descriptor's tools.
 *
 * IDEMPOTENT for the SAME descriptor instance: re-registering the exact same object
 * reference is a no-op (some module loaders — e.g. tsx's CJS interop — evaluate
 * connectors/index.ts more than once, registering the same singleton twice; that is
 * NOT a collision). A DIFFERENT descriptor reusing an existing provider id or tool
 * name is still a hard error. Use {@link resetConnectors} in tests to start clean.
 */
export function registerConnector(d: ConnectorDescriptor): void {
  const existingProvider = descriptors.find((x) => x.provider === d.provider);
  if (existingProvider) {
    if (existingProvider === d) return; // same singleton re-evaluated — no-op.
    throw new Error(
      `[connector-registry] provider "${d.provider}" is already registered by a different descriptor (provider-id collision).`,
    );
  }

  const ownNames = new Set(d.toolDefs.map((t) => t.name));

  // 1. No duplicate tool names ACROSS descriptors (and none within this one).
  const seenLocal = new Set<string>();
  for (const t of d.toolDefs) {
    if (seenLocal.has(t.name)) {
      throw new Error(
        `[connector-registry] provider "${d.provider}" declares tool "${t.name}" twice.`,
      );
    }
    seenLocal.add(t.name);
    const existing = toolNameOwner.get(t.name);
    if (existing) {
      throw new Error(
        `[connector-registry] tool name "${t.name}" is claimed by both "${existing.provider}" and "${d.provider}" — duplicate tool names across connectors are forbidden.`,
      );
    }
  }

  // 3. Every egress key must be one of THIS descriptor's tool names.
  for (const toolName of Object.keys(d.egress)) {
    if (!ownNames.has(toolName)) {
      throw new Error(
        `[connector-registry] provider "${d.provider}" maps egress for "${toolName}", which is not one of its tools.`,
      );
    }
  }

  // Commit: index the names, then add the descriptor.
  for (const t of d.toolDefs) toolNameOwner.set(t.name, d);
  descriptors.push(d);
}

/** All registered descriptors (read-only copy). */
export function getConnectorDescriptors(): readonly ConnectorDescriptor[] {
  return [...descriptors];
}

/** Every registered provider id (for runtime-config enablement validation/UI). */
export function allConnectorProviders(): string[] {
  return descriptors.map((d) => d.provider);
}

/** The provider ids of every COMMERCIAL-ONLY (breadth) connector — the set the gov
 *  guardrails strip from an org's enabledConnectors on a flip to GOV (Nango today). */
export function commercialOnlyProviders(): string[] {
  return descriptors.filter((d) => (d.availability ?? "all") === "commercial-only").map((d) => d.provider);
}

/**
 * The flat list of every registered connector's tool schemas, in registration
 * order (which is also the order descriptors append to the model tool list). The
 * agent loop is order-insensitive — it routes tool_use by name — but we keep a
 * deterministic order so the tool list is stable across runs.
 *
 * ── D5 gov-block, LAYER 1 (the model never SEES it) ────────────────────────────
 * When `tenantClass` is supplied, EXCLUDE every `commercial-only` descriptor's tools
 * for `tenantClass === "gov"` — so a gov tenant's model tool list contains NO Nango
 * tool at all (it cannot ask for what it cannot see). For "commercial" (and for
 * "all"-availability connectors regardless of class) the list is UNCHANGED — Google/
 * GitHub/native behave exactly as before. Omitting `tenantClass` returns the full set
 * (the legacy/static `cosmosTools` snapshot path; the agent loop ALWAYS passes a class).
 */
export function connectorToolDefs(
  tenantClass?: TenantClass,
  enabled?: ConnectorEnabledFilter,
): ConnectorDescriptor["toolDefs"] {
  return descriptors
    .filter((d) => isAvailableTo(d, tenantClass ?? "commercial"))
    // ── GUI runtime-config (design §8) — per-org connector ENABLEMENT ──────────────
    // Narrow further by the org's runtime config: a disabled provider's tools are not
    // offered, and a breadth connector's tools are hidden when breadthEnabled=false.
    // Omitting `enabled` ⇒ no narrowing (today's behavior; the invariant default case).
    .filter((d) => isEnabledByConfig(d, enabled))
    .flatMap((d) => d.toolDefs);
}

/**
 * The set of connector tool names — O(1) dispatch membership. Tenant-aware: when a
 * class is given, a `commercial-only` tool is NOT a member for gov (so the dispatcher
 * won't route it to the connector layer for a gov tenant — though L2/L3 below still
 * hard-refuse if it somehow reaches here). Omitting the class returns the full set.
 */
export function connectorToolNames(
  tenantClass?: TenantClass,
  enabled?: ConnectorEnabledFilter,
): ReadonlySet<string> {
  // No tenant class AND no enablement filter ⇒ the FULL set (the dispatcher's membership
  // path uses this so a forged call still ROUTES into the connector layer and is refused
  // there — never falls through to "Unknown tool").
  if (tenantClass === undefined && enabled === undefined) return new Set(toolNameOwner.keys());
  const names = new Set<string>();
  for (const [name, owner] of toolNameOwner) {
    if (isAvailableTo(owner, tenantClass ?? "commercial") && isEnabledByConfig(owner, enabled)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Route a tool call to its OWNING descriptor's executor. Throws if the name isn't a
 * registered connector tool — callers MUST gate on `connectorToolNames().has(name)`
 * first (the dispatcher does), so reaching here with an unknown name is a bug, not a
 * "fall through to native tools" path.
 */
export function executeConnectorTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ConnectorToolContext,
): Promise<unknown> {
  const owner = toolNameOwner.get(name);
  if (!owner) {
    throw new Error(
      `[connector-registry] no connector owns tool "${name}" — gate on connectorToolNames() before dispatching.`,
    );
  }

  // ── D5 gov-block, LAYER 2 (dispatch refusal) ─────────────────────────────────
  // Even if a commercial-only tool somehow reached dispatch for a gov tenant (it
  // can't via L1 — the model never saw it — but a direct/forged call must still
  // fail), refuse HARD here before the executor runs. AUDIT the refusal as an
  // egress decision (AC-3/AU evidence: a commercial-only tool was denied to gov).
  // The hash is of the ARGS (no CUI is added; this is a denial, nothing executes).
  if (!isAvailableTo(owner, ctx.tenantClass)) {
    logEgressDecision({
      conversationId: ctx.conversationId ?? "n/a",
      turn: -1,
      valueKind: "tool_args",
      toolName: name,
      exposed: false,
      withheldCount: 1,
      contentHash: sha256Hex(JSON.stringify(input ?? {})),
      decidedBy: "connector_availability_block",
      tenantClass: ctx.tenantClass ?? "gov",
      mode: "enforced",
    });
    // Reject (not a SYNC throw) so the refusal is a clean Promise rejection — the
    // function's contract is Promise<unknown> and every caller `await`s it.
    return Promise.reject(
      new Error(
        `[connector-registry] tool "${name}" belongs to a commercial-only connector ` +
          `("${owner.provider}") and is NOT available to a gov tenant — refusing dispatch (D5).`,
      ),
    );
  }

  // ── GUI runtime-config gate (DEFENSE IN DEPTH behind the tool-list filter) ───────
  // The org's runtime config may have DISABLED this connector (provider not in the
  // enabledConnectors allowlist) or DISABLED breadth (breadthEnabled=false). The model
  // never saw the tool (the tool-list filter excluded it), but a DIRECT/forged call must
  // still be refused HERE. AUDIT the refusal as an egress decision (the hash is of the
  // ARGS — nothing executes, no CUI is added).
  if (ctx.enabled && !isEnabledByConfig(owner, ctx.enabled)) {
    logEgressDecision({
      conversationId: ctx.conversationId ?? "n/a",
      turn: -1,
      valueKind: "tool_args",
      toolName: name,
      exposed: false,
      withheldCount: 1,
      contentHash: sha256Hex(JSON.stringify(input ?? {})),
      decidedBy: "connector_disabled_block",
      tenantClass: ctx.tenantClass ?? "gov",
      mode: "enforced",
    });
    return Promise.reject(
      new Error(
        `[connector-registry] tool "${name}" belongs to connector "${owner.provider}", ` +
          `which is DISABLED by this org's runtime config — refusing dispatch (runtime-config gate).`,
      ),
    );
  }

  return owner.execute(name, input, ctx);
}

/**
 * Merge every descriptor's egress contributions into the three maps the egress
 * projection layer consumes. Guards against silent collisions: two connectors must
 * not map the same tool name (already impossible — tool names are unique) and must
 * not redefine the same entity type's field allowlist with DIFFERENT fields.
 */
export function connectorEgressMaps(): ConnectorEgressMaps {
  const toolEntity: Record<string, string> = {};
  const exposableFields: Record<string, readonly string[]> = {};
  const handleableFields: Record<string, readonly string[]> = {};

  const assertConsistent = (
    map: Record<string, readonly string[]>,
    entityType: string,
    fields: readonly string[],
    which: string,
    provider: string,
  ) => {
    const prior = map[entityType];
    if (prior && JSON.stringify(prior) !== JSON.stringify(fields)) {
      throw new Error(
        `[connector-registry] provider "${provider}" redefines ${which} for entity "${entityType}" with different fields than an earlier connector — refusing to merge ambiguous egress.`,
      );
    }
  };

  for (const d of descriptors) {
    for (const [toolName, entry] of Object.entries(d.egress)) {
      toolEntity[toolName] = entry.entityType;
    }
    for (const [entityType, fields] of Object.entries(d.exposableFields ?? {})) {
      assertConsistent(exposableFields, entityType, fields, "EXPOSABLE_FIELDS", d.provider);
      exposableFields[entityType] = fields;
    }
    for (const [entityType, fields] of Object.entries(d.handleableFields ?? {})) {
      assertConsistent(handleableFields, entityType, fields, "HANDLEABLE_FIELDS", d.provider);
      handleableFields[entityType] = fields;
    }
  }

  return { toolEntity, exposableFields, handleableFields };
}

/**
 * Clear the registry. TEST-ONLY: lets a unit test register a fresh set of fixtures
 * without the real connectors (or another test's fixtures) bleeding in. Production
 * code registers exactly once via `connectors/index.ts`.
 */
export function resetConnectors(): void {
  descriptors.length = 0;
  toolNameOwner.clear();
}
