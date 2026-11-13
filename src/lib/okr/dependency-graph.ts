/**
 * Objective dependencies form a directed graph: an edge `objectiveId ->
 * dependsOnId` reads "this objective needs that one first". A loop in it
 * (A needs B, B needs A) can never be satisfied, so a new edge that would
 * close one is refused. Pure, so the rule is testable without a database.
 */
export interface DependencyEdge {
  objectiveId: string;
  dependsOnId: string;
}

/**
 * Would adding `from -> to` close a loop? True when `from` can already be
 * reached from `to` by following existing edges (including `from === to`).
 */
export function wouldCreateCycle(edges: readonly DependencyEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.objectiveId);
    if (list) list.push(e.dependsOnId);
    else next.set(e.objectiveId, [e.dependsOnId]);
  }
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length) {
    const at = stack.pop()!;
    for (const n of next.get(at) ?? []) {
      if (n === from) return true;
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return false;
}
