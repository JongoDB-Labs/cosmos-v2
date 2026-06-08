/**
 * List-projection for the cross-project work-item query. Defines the row shape
 * returned to the client and the function that executes the (already
 * RBAC-scoped) query, resolving the cross-references a flat WorkItem row lacks:
 * project key, work-item type label, assignee displayName, and a parent label.
 *
 * NEVER includes OrgMember.permissions (BigInt) — the only serialised user
 * fields are id + displayName + avatarUrl from the User table.
 */
import { prisma } from "@/lib/db/client";
import type { Priority } from "@prisma/client";
import { buildWorkItemWhere, buildOrderBy } from "./build-where";
import type { WorkItemFilter, WorkItemSort } from "./filter";

/** A single row in the org-wide Issues list. Fully serialisable (no BigInt). */
export interface IssueRow {
  id: string;
  ticketNumber: number;
  /** Human ticket key, e.g. "VITL-128" (projectKey-ticketNumber). */
  ticketKey: string;
  title: string;
  /** Status lane (board column key). */
  columnKey: string;
  priority: Priority;
  type: { id: string; key: string; name: string; icon: string | null; color: string | null };
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  parent: { id: string; ticketKey: string; title: string } | null;
  cycleId: string | null;
  storyPoints: number | null;
  tags: string[];
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunQueryArgs {
  orgId: string;
  allowedProjectIds: string[];
  filter: WorkItemFilter;
  sort: WorkItemSort | undefined;
  page: number;
  pageSize: number;
}

export interface RunQueryResult {
  data: IssueRow[];
  total: number;
}

/**
 * Execute the RBAC-scoped query and return the paginated, projected rows + the
 * total matching count. Assumes `allowedProjectIds` has already been resolved
 * via `getReadableProjectIds` — this function does NOT itself authorise.
 */
export async function runWorkItemQuery(args: RunQueryArgs): Promise<RunQueryResult> {
  const where = buildWorkItemWhere({
    orgId: args.orgId,
    allowedProjectIds: args.allowedProjectIds,
    filter: args.filter,
  });
  const orderBy = buildOrderBy(args.sort);
  const skip = (args.page - 1) * args.pageSize;

  const [items, total] = await Promise.all([
    prisma.workItem.findMany({
      where,
      orderBy,
      skip,
      take: args.pageSize,
      select: {
        id: true,
        ticketNumber: true,
        title: true,
        columnKey: true,
        priority: true,
        assigneeId: true,
        parentId: true,
        cycleId: true,
        storyPoints: true,
        tags: true,
        startDate: true,
        dueDate: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        projectId: true,
        workItemType: {
          select: { id: true, key: true, name: true, icon: true, color: true },
        },
      },
    }),
    prisma.workItem.count({ where }),
  ]);

  // Resolve cross-references in batch (projects, assignees, parents) — a flat
  // WorkItem row carries only ids.
  const projectIds = [...new Set(items.map((i) => i.projectId))];
  const assigneeIds = [...new Set(items.map((i) => i.assigneeId).filter((x): x is string => !!x))];
  const parentIds = [...new Set(items.map((i) => i.parentId).filter((x): x is string => !!x))];

  const [projects, assignees, parents] = await Promise.all([
    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, key: true, name: true },
        })
      : Promise.resolve([]),
    assigneeIds.length
      ? prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          // displayName + avatarUrl only — never permissions/BigInt.
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : Promise.resolve([]),
    parentIds.length
      ? prisma.workItem.findMany({
          // RBAC: a readable child may have a parent in a project the actor
          // CANNOT read. Scope the parent fetch to the org + the actor's
          // readable project set so an out-of-scope parent resolves to null
          // (the projection below already tolerates a missing parent) — never
          // leaking its title/ticketKey across the project boundary.
          where: {
            id: { in: parentIds },
            orgId: args.orgId,
            projectId: { in: args.allowedProjectIds },
          },
          select: { id: true, ticketNumber: true, title: true, projectId: true },
        })
      : Promise.resolve([]),
  ]);

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const assigneeById = new Map(assignees.map((u) => [u.id, u]));
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const data: IssueRow[] = items.map((item) => {
    const project = projectById.get(item.projectId);
    const projectKey = project?.key ?? "";
    const assignee = item.assigneeId ? assigneeById.get(item.assigneeId) : undefined;
    const parentRow = item.parentId ? parentById.get(item.parentId) : undefined;
    const parentProject = parentRow ? projectById.get(parentRow.projectId) : undefined;
    const parentKey = parentProject?.key ?? projectKey;

    return {
      id: item.id,
      ticketNumber: item.ticketNumber,
      ticketKey: `${projectKey}-${item.ticketNumber}`,
      title: item.title,
      columnKey: item.columnKey,
      priority: item.priority,
      type: {
        id: item.workItemType.id,
        key: item.workItemType.key,
        name: item.workItemType.name,
        icon: item.workItemType.icon,
        color: item.workItemType.color,
      },
      project: {
        id: item.projectId,
        key: projectKey,
        name: project?.name ?? "",
      },
      assignee: assignee
        ? { id: assignee.id, displayName: assignee.displayName, avatarUrl: assignee.avatarUrl }
        : null,
      parent: parentRow
        ? {
            id: parentRow.id,
            ticketKey: `${parentKey}-${parentRow.ticketNumber}`,
            title: parentRow.title,
          }
        : null,
      cycleId: item.cycleId,
      storyPoints: item.storyPoints,
      tags: item.tags,
      startDate: item.startDate ? item.startDate.toISOString() : null,
      dueDate: item.dueDate ? item.dueDate.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  });

  return { data, total };
}
