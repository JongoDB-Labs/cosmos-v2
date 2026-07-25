import type { WorkItem, OrgMember } from "@/types/models";
import type { IssueDetailRow } from "@/components/work-items/issue-detail-sheet";

/** Lookup context for turning a board's WorkItem into a detail-sheet row. The
 *  board table already holds the project + member data, so the mapping stays a
 *  pure function of (item, context) — no I/O, fully unit-testable. */
export interface DetailRowContext {
  projectId: string;
  projectKey: string;
  /** Only shown as a fallback label; the sheet renders the project KEY, so an
   *  absent name safely degrades to the key. */
  projectName?: string;
  membersById: Map<string, OrgMember>;
}

/**
 * Map a board WorkItem to the read-focused {@link IssueDetailRow} the shared
 * IssueDetailSheet consumes. Ticket keys are composed as `KEY-<number>` and the
 * assignee is resolved from the board's member map (falling back to a plain
 * "Unknown" label if the id isn't a current member).
 */
export function workItemToDetailRow(
  item: WorkItem,
  ctx: DetailRowContext,
): IssueDetailRow {
  const { projectId, projectKey, projectName, membersById } = ctx;

  const assignee = resolveAssignee(item.assigneeId, membersById);

  return {
    id: item.id,
    ticketKey: `${projectKey}-${item.ticketNumber}`,
    title: item.title,
    columnKey: item.columnKey,
    priority: item.priority,
    type: {
      name: item.workItemType?.name ?? "",
      icon: item.workItemType?.icon ?? null,
    },
    project: { id: projectId, key: projectKey, name: projectName ?? projectKey },
    assignee,
    parent: item.parent
      ? {
          id: item.parent.id,
          ticketKey: `${projectKey}-${item.parent.ticketNumber}`,
          title: item.parent.title,
        }
      : null,
    storyPoints: item.storyPoints,
    tags: item.tags,
    startDate: item.startDate,
    dueDate: item.dueDate,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function resolveAssignee(
  assigneeId: string | null,
  membersById: Map<string, OrgMember>,
): IssueDetailRow["assignee"] {
  if (!assigneeId) return null;
  const member = membersById.get(assigneeId);
  const user = member?.user;
  if (!user) return { id: assigneeId, displayName: "Unknown", avatarUrl: null };
  return {
    id: assigneeId,
    displayName: user.displayName ?? user.email ?? "Unknown",
    avatarUrl: user.avatarUrl ?? null,
  };
}
