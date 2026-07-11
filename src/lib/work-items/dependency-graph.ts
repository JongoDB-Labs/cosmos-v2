import { LinkType } from "@prisma/client";

/**
 * A normalized directed dependency edge: `from` must be completed before `to`
 * (equivalently, `to` depends on `from`). Soft/undirected relationships
 * (RELATES / DUPLICATES / CLONES) have no direction and are excluded.
 */
export interface DirectedEdge {
  from: string;
  to: string;
}

/**
 * Normalize a typed `WorkItemLink` into a directed "must-come-before" edge, or
 * `null` for soft/undirected relationships. This MUST mirror the direction the
 * dependency map draws (see `components/boards/dependencies/dependency-map.tsx`)
 * so the create-time cycle guard and the visualization agree on what a cycle is:
 *   - BLOCKS / PREDECESSOR:   source → target   (target depends on source)
 *   - BLOCKED_BY / SUCCESSOR: target → source   (source depends on target)
 *   - RELATES / DUPLICATES / CLONES: no direction (undirected, can't form a cycle)
 */
export function directedDependencyEdge(
  type: LinkType,
  sourceItemId: string,
  targetItemId: string,
): DirectedEdge | null {
  switch (type) {
    case LinkType.BLOCKS:
    case LinkType.PREDECESSOR:
      return { from: sourceItemId, to: targetItemId };
    case LinkType.BLOCKED_BY:
    case LinkType.SUCCESSOR:
      return { from: targetItemId, to: sourceItemId };
    default:
      // RELATES / DUPLICATES / CLONES — undirected, never part of a dependency cycle.
      return null;
  }
}

/**
 * Would adding `candidate` (a `from → to` edge) introduce a circular dependency
 * into the directed graph formed by `existing`? True iff `to` can already reach
 * `from` along existing edges — so `from → to` would close a loop. A self-edge
 * (`from === to`) is trivially a cycle.
 *
 * The traversal carries its own `seen` set, so it terminates even when `existing`
 * ALREADY contains a cycle (e.g. legacy/imported links) — it never assumes the
 * prior graph is acyclic.
 */
export function wouldCreateDependencyCycle(
  existing: DirectedEdge[],
  candidate: DirectedEdge,
): boolean {
  if (candidate.from === candidate.to) return true;

  // Adjacency: node → nodes that depend on it (from → [to, …]).
  const adj = new Map<string, string[]>();
  for (const e of existing) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  // DFS from `candidate.to`; if we can reach `candidate.from`, the new edge
  // `from → to` closes a cycle.
  const seen = new Set<string>();
  const stack: string[] = [candidate.to];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === candidate.from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) stack.push(next);
  }
  return false;
}
