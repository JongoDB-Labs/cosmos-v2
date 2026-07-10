/**
 * Row ordering for the interactive Gantt / Timeline (`timeline-view.tsx`).
 *
 * The timeline draws a depth-first parent→children row list. Extracted here as a
 * pure helper (like `backlog-dnd.ts`) so the ordering rules are unit-testable
 * without a live Gantt.
 *
 * Ordering rules:
 *  - Roots (items with no in-view parent) are ordered by start date — the
 *    schedule-first default a Gantt wants.
 *  - Sub-items (children of an in-view parent) honor the MANUAL order a user set
 *    by drag-reordering them in the detail sheet, persisted as `sortOrder` among
 *    siblings (FR COSMOS-5). Ties — every sibling still at the default
 *    `sortOrder` 0 because none were ranked — fall back to start date so the
 *    Gantt looks the same as before anyone reordered.
 */

/** The minimal item shape the tree builder reads. */
export interface TimelineTreeNode {
  id: string;
  parentId: string | null;
  startDate: string | null;
  createdAt: string;
  sortOrder: number;
}

export interface TimelineRow<T> {
  item: T;
  depth: number;
}

export interface TimelineTree<T> {
  treeRows: TimelineRow<T>[];
  /** Ids that have at least one child in view (i.e. are collapsible parents). */
  parentIds: Set<string>;
}

const startMs = (n: TimelineTreeNode): number =>
  new Date(n.startDate ?? n.createdAt).getTime();

/**
 * Build the depth-first row list for the timeline. A child whose parent is not
 * in `items` surfaces as a root, so a filter can never silently hide it.
 * `collapsedIds` members keep their own row but their subtree is omitted.
 */
export function buildTimelineTree<T extends TimelineTreeNode>(
  items: T[],
  collapsedIds: ReadonlySet<string>,
): TimelineTree<T> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const it of items) {
    if (it.parentId && byId.has(it.parentId)) {
      const arr = kids.get(it.parentId) ?? [];
      arr.push(it);
      kids.set(it.parentId, arr);
    } else {
      roots.push(it);
    }
  }

  const byStart = (a: T, b: T) => startMs(a) - startMs(b);
  // Sub-items honor the manual sortOrder; start date only breaks ties.
  const bySortThenStart = (a: T, b: T) => a.sortOrder - b.sortOrder || byStart(a, b);
  roots.sort(byStart);
  for (const arr of kids.values()) arr.sort(bySortThenStart);

  const rows: TimelineRow<T>[] = [];
  const seen = new Set<string>(); // cycle guard (bad parentId data can't hang us)
  const walk = (it: T, depth: number) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    rows.push({ item: it, depth });
    if (collapsedIds.has(it.id)) return;
    for (const k of kids.get(it.id) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  return { treeRows: rows, parentIds: new Set(kids.keys()) };
}
