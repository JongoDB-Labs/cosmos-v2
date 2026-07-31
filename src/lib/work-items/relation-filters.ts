/**
 * The board lenses that need a RELATION rather than a field on the item.
 *
 * Milestone membership and blocked-ness both live in join tables, so unlike
 * status or label they can't be answered from the card alone. Each is resolved
 * once into a Set and then asked per item, rather than scanning the links for
 * every card — a board of 500 items against a few hundred links is otherwise
 * quadratic for a filter nobody notices is slow until it is.
 */

export type BlockedFilter = "any" | "blocked" | "unblocked";

export const BLOCKED_OPTIONS: { value: BlockedFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "blocked", label: "Blocked" },
  { value: "unblocked", label: "Not blocked" },
];

export interface LinkLike {
  sourceItemId: string;
  targetItemId: string;
  type: string;
}

/**
 * Which items are blocked by something.
 *
 * The direction matters and is easy to get backwards, so it is spelled out:
 *
 *   A --BLOCKS--> B      ⇒ B is blocked (the TARGET)
 *   A --BLOCKED_BY--> B  ⇒ A is blocked (the SOURCE)
 *
 * Both spellings exist in LinkType and both are used, so reading only one of
 * them would quietly under-report — the worse failure here, since a board
 * filtered to "blocked" that hides blocked work is actively misleading.
 */
export function blockedItemIds(links: LinkLike[]): Set<string> {
  const blocked = new Set<string>();
  for (const l of links) {
    if (l.type === "BLOCKS") blocked.add(l.targetItemId);
    else if (l.type === "BLOCKED_BY") blocked.add(l.sourceItemId);
  }
  return blocked;
}

export function matchesBlocked(
  itemId: string,
  filter: BlockedFilter,
  blocked: Set<string>,
): boolean {
  if (filter === "any") return true;
  return filter === "blocked" ? blocked.has(itemId) : !blocked.has(itemId);
}

export interface MilestoneLike {
  id: string;
  title: string;
  links?: { workItemId: string }[] | null;
}

/** workItemId → the milestones it is linked to. An item may serve several. */
export function milestoneItemIds(milestones: MilestoneLike[]): Map<string, Set<string>> {
  const byMilestone = new Map<string, Set<string>>();
  for (const m of milestones) {
    byMilestone.set(m.id, new Set((m.links ?? []).map((l) => l.workItemId)));
  }
  return byMilestone;
}

export function matchesMilestone(
  itemId: string,
  milestoneId: string | null,
  byMilestone: Map<string, Set<string>>,
): boolean {
  if (!milestoneId) return true; // inert
  return byMilestone.get(milestoneId)?.has(itemId) ?? false;
}

/**
 * Story points, as a multi-select over the values actually on the board.
 *
 * Not a comparator (`> 5`). Points are a small, conventional set — 1, 2, 3, 5,
 * 8, 13 — so picking the ones you mean is fewer decisions than choosing an
 * operator and typing a number, and it matches how every other control in this
 * bar behaves. `NONE` is an explicit option because "unestimated" is a question
 * teams ask constantly and no comparator expresses it.
 */
export const NO_ESTIMATE = "NONE";

export function presentStoryPoints(items: { storyPoints?: number | null }[]): string[] {
  const seen = new Set<string>();
  let anyUnestimated = false;
  for (const i of items) {
    if (i.storyPoints == null) anyUnestimated = true;
    else seen.add(String(i.storyPoints));
  }
  const numeric = [...seen].sort((a, b) => Number(a) - Number(b));
  return anyUnestimated ? [...numeric, NO_ESTIMATE] : numeric;
}

export function matchesStoryPoints(
  storyPoints: number | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true;
  if (storyPoints == null) return selected.includes(NO_ESTIMATE);
  return selected.includes(String(storyPoints));
}
