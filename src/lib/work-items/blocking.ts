/**
 * Which dependency edges represent an impediment, and who is impeding whom.
 *
 * The Gantt draws every dependency in the same neutral grey, so on a board of
 * any size "what is stuck, and behind what" is invisible. The Blocked lens needs
 * both halves: which EDGES block, and for a blocked item, which items block it.
 *
 * Direction is the subtlety, and getting it backwards points the arrow from the
 * victim at the thing it is holding up — the exact opposite of the truth:
 *
 *   A BLOCKS B      ⇒ B is blocked, by A   (source blocks target)
 *   A BLOCKED_BY B  ⇒ A is blocked, by B   (source is blocked by target)
 *
 * Matches `blockedItemIds`, so the lens and the Blocked filter never disagree
 * about what counts as blocked.
 */

interface LinkLike {
  type: string;
  sourceItemId: string;
  targetItemId: string;
}

export function isBlockingLink(type: string): boolean {
  return type === "BLOCKS" || type === "BLOCKED_BY";
}

/** blocked item id → the ids of the items blocking it. */
export function blockersByItem(links: LinkLike[]): Map<string, Set<string>> {
  const byItem = new Map<string, Set<string>>();

  const add = (blocked: string, blocker: string) => {
    // Malformed data; an arrow from a bar to itself is noise at best.
    if (blocked === blocker) return;
    const set = byItem.get(blocked) ?? new Set<string>();
    set.add(blocker);
    byItem.set(blocked, set);
  };

  for (const l of links) {
    if (l.type === "BLOCKS") add(l.targetItemId, l.sourceItemId);
    else if (l.type === "BLOCKED_BY") add(l.sourceItemId, l.targetItemId);
  }

  return byItem;
}
