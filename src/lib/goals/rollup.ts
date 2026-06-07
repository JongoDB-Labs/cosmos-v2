import type { Goal, GoalLink } from "@prisma/client";

export type GoalWithLinks = Goal & { links: GoalLink[] };

/** A column key is treated as "done" when it equals 'done'. */
function isWorkItemDone(columnKey: string): boolean {
  return columnKey === "done";
}

/**
 * Roll up an AUTO goal's progress (0-100) from its links.
 *
 * - WORK_ITEM links contribute one bucket: (# done / # resolvable) * 100.
 * - Each resolvable OBJECTIVE link contributes its own `progress` (0-100).
 * - The final value is the rounded average of the work-item bucket (if any
 *   work items resolved) and every objective value.
 *
 * Dangling links (the referenced item/objective was deleted) are skipped. If no
 * links resolve to anything, returns `null` so the caller can fall back to the
 * goal's stored `progress`.
 */
export function computeAutoProgress(
  goal: GoalWithLinks,
  workItemById: Map<string, { id: string; columnKey: string }>,
  objectiveById: Map<string, { id: string; progress: number }>,
): number | null {
  let totalWorkItems = 0;
  let doneWorkItems = 0;
  const objectiveValues: number[] = [];

  for (const link of goal.links) {
    if (link.kind === "WORK_ITEM" && link.workItemId) {
      const item = workItemById.get(link.workItemId);
      if (!item) continue; // dangling link
      totalWorkItems += 1;
      if (isWorkItemDone(item.columnKey)) doneWorkItems += 1;
    } else if (link.kind === "OBJECTIVE" && link.objectiveId) {
      const objective = objectiveById.get(link.objectiveId);
      if (!objective) continue; // dangling link
      objectiveValues.push(objective.progress);
    }
  }

  const buckets: number[] = [];
  if (totalWorkItems > 0) {
    buckets.push((doneWorkItems / totalWorkItems) * 100);
  }
  buckets.push(...objectiveValues);

  if (buckets.length === 0) return null;

  const avg = buckets.reduce((sum, v) => sum + v, 0) / buckets.length;
  return Math.round(avg);
}
