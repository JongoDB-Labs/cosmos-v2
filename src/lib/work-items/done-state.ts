import { CANCELLED_COLUMN } from "@/lib/boards/default-columns";

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
  /** A `ColumnCategory`; typed loosely so client status lists fit as they are. */
  category?: string;
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

/** Words a done lane's key carries, as the sprint report matched them before categories. */
const DONE_WORDS = ["done", "completed", "closed", "finished"] as const;

/**
 * Is an item in status `columnKey` finished, for a sprint's figures (the
 * report, the review, what carries over) and the feedback a reporter sees?
 *
 * The status's CATEGORY decides when someone set one: DONE is done, and
 * IN_PROGRESS or CANCELLED is not, whatever the lane is called ("Shipped"
 * counts; a "Done" lane re-categorised to In Progress does not).
 *
 * TODO is not trusted on its own. It is the column default, stored for every
 * column created without a category (templates, the columns API), and no
 * backfill ever set it. So a "Completed" lane may well be stored as TODO, and
 * these figures counted it done by its name before categories were read. For
 * TODO, and for a key no board shows, the key's spelling still decides, so
 * completing a sprint never carries finished work forward or flips delivered
 * feedback back to Planned.
 */
export function isDoneStatus(
  columnKey: string | null | undefined,
  columns: readonly DoneStateColumn[] = [],
): boolean {
  if (!columnKey) return false;

  const category = columns.find((c) => c.key === columnKey)?.category;
  if (category && category !== "TODO") return category === "DONE";

  const key = columnKey.toLowerCase();
  return DONE_WORDS.some((w) => key.includes(w));
}

/**
 * Does an item in status `columnKey` need no more work — finished OR abandoned?
 *
 * The status-only sibling of {@link isWorkItemResolved}, standing to it exactly
 * as `isDoneStatus` stands to `isWorkItemDone`: the same question, in the shape
 * the sprint surfaces have (a status key plus the project's statuses, no item
 * row). Written for the carry-forward set — what rolls into the next sprint, and
 * the count the review boards label "carried over".
 *
 * Cancelled-as-duplicate work was carrying forward sprint after sprint
 * (COSMOS-246): `isDoneStatus` answers "was this DELIVERED", which a cancelled
 * item was not, and that was being read as "is this still outstanding", which it
 * also was not. Merging duplicates (COSMOS-207) leaves the loser Cancelled ON
 * ITS SPRINT, so every merge fed the list.
 *
 * Status ALONE decides. A cancelled item needs no more work whether or not
 * anyone recorded a cancellation date, so carry-forward never asks for one — the
 * date is a record of when it settled, not what makes it settled.
 *
 * NOT a widening of "done": velocity, committed points, what shipped and the
 * completion percentage all keep asking `isDoneStatus`, because cancelled work
 * was not delivered. That split is why CANCELLED is its own category
 * (COSMOS-206) and `isWorkItemResolved` is separate from `isWorkItemDone`.
 */
export function isResolvedStatus(
  columnKey: string | null | undefined,
  columns: readonly DoneStateColumn[] = [],
): boolean {
  if (isDoneStatus(columnKey, columns)) return true;
  if (!columnKey) return false;

  // Mirrors isDoneStatus's precedence, including distrusting the TODO default
  // that every uncategorised column carries, so the two cannot disagree about
  // which signal wins for a given column.
  const category = columns.find((c) => c.key === columnKey)?.category;
  if (category && category !== "TODO") return category === "CANCELLED";

  // Unknown to this surface, or stored as the TODO default — fall back to the
  // seeded Cancelled lane's key, imported rather than spelled again.
  return columnKey.toLowerCase() === CANCELLED_COLUMN.key;
}

/**
 * Does this item need no more work — finished OR abandoned?
 *
 * Distinct from {@link isWorkItemDone} ON PURPOSE, and the distinction is
 * load-bearing: Cancelled is its own category precisely so abandoned work is
 * "neither reported as delivered nor deleted" (COSMOS-206). Widening
 * `isWorkItemDone` to include it would quietly feed cancelled items into
 * velocity, sprint figures and parent rollups as DELIVERED work, which is the
 * opposite of why the category exists.
 *
 * So this is the ITEM-shaped answer, used by the places that strike out a
 * settled item. {@link isResolvedStatus} is the same rule for a bare status key,
 * which is all the sprint surfaces hold.
 * BUG 635be41c: a sub-item in the Done column was struck through and one in the
 * Cancelled column was not, so an abandoned child read as still outstanding. It
 * reported as "cancelled/OBE should scratch out children like DONE does"; OBE is
 * a `CancelReason` on an item sitting in a CANCELLED-category column, so the
 * category is the thing to test, and every cancel reason is covered by it.
 *
 * Mirrors `isWorkItemDone`'s shape deliberately, including the
 * column-missing-from-the-list fallback, because `board.columns` is empty on
 * several board types.
 */
export function isWorkItemResolved(
  item: DoneStateItem,
  columns: readonly DoneStateColumn[] = [],
): boolean {
  if (isWorkItemDone(item, columns)) return true;

  const columnKey = item.columnKey;
  if (!columnKey) return false;

  const column = columns.find((c) => c.key === columnKey);
  if (column) return column.category === "CANCELLED";

  // Unknown to this surface — fall back to the seeded Cancelled lane's key,
  // imported rather than spelled again so the two cannot drift.
  return columnKey.toLowerCase() === CANCELLED_COLUMN.key;
}
