/**
 * Default work-item type for a new sub-item — one hierarchy level below its
 * parent (e.g. under an Epic → Story, under a Story → Task).
 *
 * The rule is data-driven off the org's actual type hierarchy
 * (`WorkItemType.defaultParentTypeKey`), so it stays correct for every sector
 * and for custom types — not just the built-in software epic→story→task chain.
 * A bare-key heuristic is the fallback for when the hierarchy metadata isn't
 * loaded yet.
 *
 * Shared so every sub-item entry point defaults the type the same way
 * (COSMOS-71 / FR 3fd0e9bd).
 */

/** The slice of a work-item type these helpers reason about. */
export interface ChildTypeCandidate {
  id: string;
  key: string;
  sortOrder: number;
  defaultParentTypeKey?: string | null;
}

/**
 * Bare-key heuristic: one level below the parent (epic→story, story→task,
 * task/bug→subtask). Keys are sector-prefixed (e.g. "software.epic"), so match
 * on the bare suffix. Used only when the org's real type hierarchy isn't
 * available (types still loading), and understood by the create API's
 * `type` → sector-prefixed lookup.
 */
export function fallbackChildTypeKey(parentTypeKey: string | undefined): string {
  const bare = parentTypeKey?.split(".").pop()?.toUpperCase();
  switch (bare) {
    case "EPIC":
      return "STORY";
    case "STORY":
      return "TASK";
    case "TASK":
    case "BUG":
      return "SUBTASK";
    default:
      return "TASK";
  }
}

/**
 * The default child type for a sub-item created under a parent of type
 * `parentTypeKey`, derived from the org's hierarchy: the lowest-`sortOrder`
 * type whose `defaultParentTypeKey` names the parent's key. (A parent can have
 * more than one candidate child — e.g. software Story is the parent of both
 * Task and Subtask — so the lowest `sortOrder` wins, keeping Story→Task.)
 *
 * Returns `null` when the hierarchy doesn't name a child (or `types` is empty);
 * callers then fall back to {@link fallbackChildTypeKey}.
 */
export function deriveChildType<T extends ChildTypeCandidate>(
  parentTypeKey: string | undefined,
  types: readonly T[],
): T | null {
  if (!parentTypeKey) return null;
  let best: T | null = null;
  for (const t of types) {
    if (t.defaultParentTypeKey !== parentTypeKey) continue;
    if (!best || t.sortOrder < best.sortOrder) best = t;
  }
  return best;
}
