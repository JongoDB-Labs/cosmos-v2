import type { ResourceAttributes } from "@/lib/abac/engine";

/**
 * What ITEM_CREATE is asked about for a new item: one row per person it will
 * be assigned to, each with the same creator and project, so a rule about whom
 * work may be created for holds for every assignee, not only the first. An
 * unassigned item is one row with no assignee: never zero rows, which would
 * ask nothing at all.
 *
 * Give it the same set the item is written with (`assigneeSetData`), computed
 * once where the request is read, so the check can't see a different set from
 * the one the item gets.
 *
 * Pass the rows to `requireAccessForEach(ctx, "ITEM_CREATE", …)`; after a gate
 * that has already decided authority (`requireProjectManage`), to
 * `requirePolicy` for each.
 */
export function itemCreateRows(
  createdById: string,
  projectId: string,
  assigneeIds: readonly string[],
): ResourceAttributes[] {
  const people = assigneeIds.length > 0 ? assigneeIds : [null];
  return people.map((assigneeId) => ({ createdById, assigneeId, projectId }));
}
