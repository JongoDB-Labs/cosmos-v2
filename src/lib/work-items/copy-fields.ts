import type { Prisma, WorkItem } from "@prisma/client";

/**
 * The planning fields a copy of a work item carries: what someone would call
 * "the same ticket". Shared by Duplicate and Split per assignee so the two can
 * never disagree about what a copy is.
 *
 * Deliberately NOT carried: identity (id, ticket number, sort order, creator),
 * the run so far (actualStart, completedAt, cancel and merge state), and
 * external-sync ids, which name the ORIGINAL in another system.
 */
export function copyFields(
  source: WorkItem,
): Omit<
  Prisma.WorkItemUncheckedCreateInput,
  "orgId" | "projectId" | "title" | "ticketNumber" | "sortOrder" | "createdById"
> {
  return {
    workItemTypeId: source.workItemTypeId,
    description: source.description,
    columnKey: source.columnKey,
    assigneeId: source.assigneeId,
    priority: source.priority,
    intervalId: source.intervalId,
    parentId: source.parentId,
    teamId: source.teamId,
    storyPoints: source.storyPoints,
    dueDate: source.dueDate,
    startDate: source.startDate,
    workCategory: source.workCategory,
    highlight: source.highlight,
    tags: source.tags,
    customFields: source.customFields ?? undefined,
    columnEnteredAt: new Date(),
  };
}
