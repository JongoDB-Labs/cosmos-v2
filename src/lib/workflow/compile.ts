/**
 * A definition compiled for lookups, and the resolution of a requested status
 * change to the transition that governs it.
 *
 * Versions are immutable, so a compiled definition is cached by version id and
 * never invalidated.
 */
import type { TransitionSpec, WorkflowDefinition, StatusRef } from "@/lib/workflow/definition";

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  statusKeys: ReadonlySet<string>;
  initialStatus: string;
  /** Transitions that may start from `status`, named ones first. */
  from(status: string): TransitionSpec[];
  byId(id: string): TransitionSpec | undefined;
}

export function compileWorkflow(definition: WorkflowDefinition): CompiledWorkflow {
  const statusKeys = new Set(definition.statuses.map((s) => s.key));
  // A project with no statuses yet has an empty open workflow and no initial status.
  const initialStatus = definition.statuses.find((s) => s.isInitial)?.key ?? definition.statuses[0]?.key ?? "";
  const ids = new Map(definition.transitions.map((t) => [t.id, t]));
  const global = definition.transitions.filter((t) => t.from === "*");
  const bySource = new Map<string, TransitionSpec[]>();
  for (const t of definition.transitions) {
    if (t.from === "*") continue;
    for (const f of t.from) bySource.set(f, [...(bySource.get(f) ?? []), t]);
  }
  return {
    definition,
    statusKeys,
    initialStatus,
    from: (status) => [...(bySource.get(status) ?? []), ...global],
    byId: (id) => ids.get(id),
  };
}

const cache = new Map<string, CompiledWorkflow>();
const CACHE_MAX = 500;

/** `compileWorkflow`, memoised by the immutable version id. */
export function compiledVersion(versionId: string, definition: WorkflowDefinition): CompiledWorkflow {
  const hit = cache.get(versionId);
  if (hit) return hit;
  const compiled = compileWorkflow(definition);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(versionId, compiled);
  return compiled;
}

export type TransitionResolution =
  | { ok: true; transition: TransitionSpec }
  | { ok: false; code: "transition_not_allowed"; message: string }
  | { ok: false; code: "transition_ambiguous"; message: string; candidates: { id: string; name: string }[] };

/**
 * Which transition a move from `from` to `to` takes.
 *
 * An explicit `transitionId` must exist, start from `from` and end at `to`.
 * Otherwise the unique transition between the two statuses is used; when
 * several qualify, a named (non-global) one wins over a global one, and a tie
 * that remains is ambiguous: the caller must name one.
 */
export function resolveTransition(
  wf: CompiledWorkflow,
  args: { from: string; to: string; transitionId?: string },
): TransitionResolution {
  const { from, to, transitionId } = args;
  if (!wf.statusKeys.has(to)) {
    return { ok: false, code: "transition_not_allowed", message: `"${to}" is not a status in this workflow.` };
  }
  const candidates = wf.from(from).filter((t) => t.to === to);
  if (transitionId) {
    const t = candidates.find((c) => c.id === transitionId);
    return t
      ? { ok: true, transition: t }
      : { ok: false, code: "transition_not_allowed", message: `That transition does not lead from "${from}" to "${to}".` };
  }
  if (candidates.length === 0) {
    return { ok: false, code: "transition_not_allowed", message: `This workflow has no way from "${from}" to "${to}".` };
  }
  const named = candidates.filter((t) => t.from !== "*");
  const pool = named.length > 0 ? named : candidates;
  if (pool.length === 1) return { ok: true, transition: pool[0] };
  return {
    ok: false,
    code: "transition_ambiguous",
    message: `Several transitions lead from "${from}" to "${to}"; pick one.`,
    candidates: pool.map((t) => ({ id: t.id, name: t.name })),
  };
}

/** The transition id a SYSTEM_OPEN workflow gives the global move into `key`. */
export function openTransitionId(key: string): string {
  return `open:${key}`;
}

/**
 * The default workflow, equal to today's behaviour: every status, one global
 * transition into each, no restrictions. The initial status is the first
 * non-archived To Do status by sort order, as the create dialogs pick it.
 */
export function buildOpenDefinition(
  statuses: readonly (StatusRef & { name: string; sortOrder: number })[],
): WorkflowDefinition {
  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
  if (ordered.length === 0) return { schemaVersion: 1, statuses: [], transitions: [] };
  const initial =
    ordered.find((s) => s.category === "TODO" && !s.archived) ?? ordered.find((s) => !s.archived) ?? ordered[0];
  return {
    schemaVersion: 1,
    statuses: ordered.map((s) => (s.key === initial.key ? { key: s.key, isInitial: true as const } : { key: s.key })),
    transitions: ordered.map((s) => ({ id: openTransitionId(s.key), name: s.name, from: "*" as const, to: s.key })),
  };
}
