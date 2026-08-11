import { isDoneColumnKey } from "./sprint-review";

/**
 * The report recorded on `intervals.report` when a sprint is completed.
 *
 * Everything a review board shows is derived from work items on read — except
 * one fact. Completing a sprint reassigns `intervalId` on every unfinished item
 * (to the next sprint, or to nothing), so the finished sprint stops owning them
 * and "items on this sprint that are not done" becomes empty. The set that
 * carried forward is unrecoverable after that moment.
 *
 * So the report stores the carried IDs, and only the IDs. That is historical
 * fact — what moved, and when — rather than a second copy of figures the work
 * items can still answer for themselves.
 *
 * Pure: the caller supplies the completion instant, so the same items always
 * produce the same report.
 */

export interface IntervalReportItem {
  id: string;
  columnKey: string;
  storyPoints?: number | null;
  priority?: string | null;
}

export interface IntervalReport {
  completedAt: string;
  totalItems: number;
  completedItems: number;
  incompleteItems: number;
  totalStoryPoints: number;
  completedStoryPoints: number;
  /** Points actually delivered — what the team achieved, not what it committed. */
  velocity: number;
  itemsByPriority: Record<string, number>;
  /**
   * The items that did not finish and were moved off this sprint. Recorded
   * because completion severs their link to it and nothing else remembers.
   */
  carriedItemIds: string[];
}

export function buildIntervalReport(
  items: IntervalReportItem[],
  completedAt: string
): IntervalReport {
  // One definition of "done", shared with the review, so a report and the board
  // that produced it cannot disagree about what shipped.
  const doneItems = items.filter((i) => isDoneColumnKey(i.columnKey));
  const carried = items.filter((i) => !isDoneColumnKey(i.columnKey));

  return {
    completedAt,
    totalItems: items.length,
    completedItems: doneItems.length,
    incompleteItems: carried.length,
    totalStoryPoints: items.reduce((s, i) => s + (i.storyPoints ?? 0), 0),
    completedStoryPoints: doneItems.reduce((s, i) => s + (i.storyPoints ?? 0), 0),
    velocity: doneItems.reduce((s, i) => s + (i.storyPoints ?? 0), 0),
    itemsByPriority: items.reduce<Record<string, number>>((acc, i) => {
      if (i.priority) acc[i.priority] = (acc[i.priority] ?? 0) + 1;
      return acc;
    }, {}),
    carriedItemIds: carried.map((i) => i.id),
  };
}
