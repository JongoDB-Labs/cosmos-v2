/**
 * May this parent be marked done yet?
 *
 * A parent finishes when its children do. Moving one into a Done column while
 * work still sits underneath it makes every rollup lie — the board says finished,
 * the children say otherwise, and the Gantt stamps a completion date on a span
 * that has not closed.
 *
 * This REPLACES the "move the parent too?" prompt, which pushed in the opposite
 * direction: it offered to drag a parent forward to match a child that had
 * overtaken it, and asked the question on every ordinary move. The safeguard
 * teams actually need runs the other way and only at the one moment it matters.
 *
 * A pure rule: children in, blockers out. The caller decides what to do about
 * them, so the same rule can gate a drag, a status dropdown, or an API call
 * without three copies of the condition.
 */

export interface ChildLike {
  id: string;
  title: string;
  /** The column the child currently sits in. */
  columnKey: string | null;
}

/**
 * The children standing in the way, in board order. Empty means the parent is
 * free to close.
 *
 * `doneKeys` is the set of column keys whose category is DONE — a project can
 * have several, and hard-coding "done" would miss "Shipped" or "Accepted".
 * CANCELLED work does not block: it is settled, just not delivered.
 */
export function blockingChildren(
  children: readonly ChildLike[],
  doneKeys: ReadonlySet<string>,
  cancelledKeys: ReadonlySet<string> = new Set(),
): ChildLike[] {
  return children.filter((c) => {
    if (c.columnKey === null) return true;
    return !doneKeys.has(c.columnKey) && !cancelledKeys.has(c.columnKey);
  });
}

/** Sentence for the block message. Names up to two children, then counts. */
export function describeBlockers(blockers: readonly ChildLike[]): string {
  if (blockers.length === 0) return "";
  const titles = blockers.map((b) => b.title);
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}
