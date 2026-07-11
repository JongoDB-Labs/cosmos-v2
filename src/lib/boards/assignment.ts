import type { WorkItem } from "@/types/models";

/**
 * Is a work item assigned to `userId`? Matches the primary assignee OR any
 * member of the multi-assignee set — the same rule the Kanban filter bar uses,
 * so the "Assigned to me" quick-filter behaves identically across every board
 * view (Backlog, Roadmap, Table, Calendar, …). Pure + dependency-free so any
 * view (or test) can share it without pulling in a heavy component module.
 */
export function isAssignedTo(item: WorkItem, userId: string): boolean {
  return (
    item.assigneeId === userId ||
    (item.assignees?.some((a) => a.userId === userId) ?? false)
  );
}
