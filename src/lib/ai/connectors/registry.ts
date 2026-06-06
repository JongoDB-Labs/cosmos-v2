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
} from "./types";

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

/**
 * The flat list of every registered connector's tool schemas, in registration
 * order (which is also the order descriptors append to the model tool list). The
 * agent loop is order-insensitive — it routes tool_use by name — but we keep a
 * deterministic order so the tool list is stable across runs.
 */
export function connectorToolDefs(): ConnectorDescriptor["toolDefs"] {
  return descriptors.flatMap((d) => d.toolDefs);
}

/** The set of every registered connector tool name — O(1) dispatch membership. */
export function connectorToolNames(): ReadonlySet<string> {
  return new Set(toolNameOwner.keys());
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
