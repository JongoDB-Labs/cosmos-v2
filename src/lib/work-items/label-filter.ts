/**
 * Does this item carry any of the selected labels?
 *
 * Labels differ from every other board filter in one way that decides the
 * semantics: an item has MANY labels, where it has exactly one type, one
 * priority, one interval. So "type is Bug or Story" asks whether the item's
 * single type is in the set, whereas "label is blocked or needs-review" asks
 * whether the item's set of labels INTERSECTS the selection.
 *
 * OR within the filter, matching how Type and Priority already behave: choosing
 * more labels widens the result rather than narrowing it. AND ("has both") is a
 * different question and would need its own control to be honest about which
 * one is being asked.
 *
 * Labels reach the client as `WorkItem.tags` — the API projects the WorkItemLabel
 * rows back onto that field — so nothing extra is fetched to support this.
 */
export function matchesLabelFilter(
  itemLabels: string[] | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true; // inert
  if (!itemLabels || itemLabels.length === 0) return false;
  return itemLabels.some((l) => selected.includes(l));
}

/**
 * Every label actually present on this board, sorted, for the filter menu.
 *
 * Deliberately derived from the items on screen rather than the org's whole
 * label catalog: a menu offering labels that cannot match anything here is a
 * menu of dead ends, and the Type filter already sets this precedent with
 * `presentTypeKeys`.
 */
export function presentLabels(items: { tags?: string[] | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const t of item.tags ?? []) if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
