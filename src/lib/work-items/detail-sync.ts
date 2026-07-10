import type { WorkItem } from "@/types/models";

/**
 * Reconcile the board's OPEN detail sheet against an `onUpdate` coming from
 * that sheet.
 *
 * A board keeps the currently-open item in its own `detailItem` state and
 * mirrors every `onUpdate` back into it so the sheet stays fresh. But the detail
 * sheet fires `onUpdate` for MORE than just the item on screen: re-parenting a
 * child also patches the OLD and NEW parent rows (so their sub-item lists stay
 * in sync — BR 7d1ae4d2 / COSMOS-67). Echoing those parent updates straight into
 * `detailItem` hijacks the sheet, flipping it away from the child the user is
 * editing to the parent they just picked.
 *
 * The open sheet should only re-point to an updated row when it IS the row on
 * screen. Everything else updates the board's list/cache but leaves the sheet
 * put.
 */
export function syncOpenDetail(
  current: WorkItem | null,
  updated: WorkItem,
): WorkItem | null {
  return current && current.id === updated.id ? updated : current;
}
