/** The minimum an interval must expose to be placed in the tree. */
export interface TreeInterval {
  id: string;
  number: number;
  intervalKind: string;
  /** The Program Increment this sits under, or null for a top-level interval. */
  parentId: string | null;
}

export interface IntervalNode<T> {
  interval: T;
  children: T[];
}

export interface IntervalTree<T> {
  /** Program Increments, each with its own sprints. */
  pis: IntervalNode<T>[];
  /** Top-level intervals that are not PIs and not inside one. */
  standalone: T[];
}

const PI_KIND = "PROGRAM_INCREMENT";

/**
 * Group intervals into Program Increments and their sprints, ordered top-down.
 *
 * The list read newest-first because the API returns `orderBy: { number:
 * "desc" }` and the UI applied no ordering of its own — so Sprint 5 sat above
 * Sprint 1, and a PI's sprints read backwards.
 *
 * The ordering lives HERE rather than in the API deliberately: five other
 * surfaces (the objectives panel, the OKR board, the scrum board, the roadmap
 * and the table view) read that same endpoint, and flipping it would silently
 * reshuffle every one of them to satisfy a decision about one screen.
 *
 * Two shapes of bad data are handled rather than dropped, because both make an
 * interval invisible with no way for a user to fix it:
 *   - a sprint whose parent PI no longer exists falls back to top level;
 *   - a PI nested under another PI is still listed as a PI. The model permits
 *     it (parentId is on every interval); this view only nests one level.
 */
export function buildIntervalTree<T extends TreeInterval>(intervals: T[]): IntervalTree<T> {
  // Ascending by number, ties broken on id so the order does not depend on the
  // order the server happened to return.
  const ordered = [...intervals].sort(
    (a, b) => a.number - b.number || a.id.localeCompare(b.id),
  );

  const pis = ordered.filter((i) => i.intervalKind === PI_KIND);
  const piIds = new Set(pis.map((p) => p.id));

  const childrenOf = new Map<string, T[]>(pis.map((p) => [p.id, []]));
  const standalone: T[] = [];

  for (const interval of ordered) {
    if (piIds.has(interval.id)) continue; // a PI is never its own child
    const bucket = interval.parentId ? childrenOf.get(interval.parentId) : undefined;
    if (bucket) bucket.push(interval);
    else standalone.push(interval); // no parent, or a parent that is gone
  }

  return {
    pis: pis.map((interval) => ({ interval, children: childrenOf.get(interval.id) ?? [] })),
    standalone,
  };
}
