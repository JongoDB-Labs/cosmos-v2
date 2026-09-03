/**
 * Is a work item finished?
 *
 * Two independent signals, either of which is enough:
 *
 *  1. **An actual end date** (`completedAt`) — someone recorded that it landed.
 *  2. **A DONE-category board column** — it is sitting in the done lane.
 *
 * They are ORed, not ANDed, and that is load-bearing. `board.columns` is EMPTY
 * on Timeline / Roadmap / Calendar / Table boards, because board creation seeds
 * no columns for those types — a fact that has silently emptied three separate
 * derived values in this codebase already. Anything requiring the column signal
 * would therefore report "nothing is done" on half the board types. With an OR,
 * a missing column list costs precision, not correctness.
 */

/** Just enough of a board column. `BoardColumn` from `@/types/models` fits. */
export interface DoneStateColumn {
  key: string;
  category?: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
}

/** Just enough of a work item. `WorkItem` and `WorkItemRef` both fit. */
export interface DoneStateItem {
  columnKey?: string | null;
  completedAt?: string | Date | null;
}

/**
 * The canonical key of the seeded done lane.
 *
 * Used ONLY when the column is absent from `columns` entirely — see below. It is
 * not a general key-sniffing fallback: `src/lib/boards/column-phase.ts` records
 * why guessing completion from a column's name is wrong (a board with a
 * "Review" column had actual-start dates stamped on the way into review), and
 * `BoardColumn.category` is the source of truth wherever it is available.
 */
const CANONICAL_DONE_KEY = "done";

/**
 * True when this item counts as finished.
 *
 * `columns` may be empty or omitted; the `completedAt` signal still applies.
 *
 * When the item's column IS present in `columns`, its `category` is believed
 * outright — so a lane a team named "Done" but re-categorised to IN_PROGRESS is
 * correctly NOT done. The `"done"` key is consulted only when the column is
 * missing from the list, which is the empty-`board.columns` case above rather
 * than a disagreement about a known column.
 */
export function isWorkItemDone(
  item: DoneStateItem,
  columns: readonly DoneStateColumn[] = [],
): boolean {
  if (item.completedAt != null) return true;

  const columnKey = item.columnKey;
  if (!columnKey) return false;

  const column = columns.find((c) => c.key === columnKey);
  if (column) return column.category === "DONE";

  // Column unknown to this surface — fall back to the seeded done lane's key.
  return columnKey.toLowerCase() === CANONICAL_DONE_KEY;
}
