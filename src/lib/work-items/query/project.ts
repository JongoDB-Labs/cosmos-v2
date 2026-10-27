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
import type { Prisma, Priority } from "@prisma/client";
import { buildWorkItemWhere, buildOrderBy } from "./build-where";
import type { WorkItemFilter, WorkItemSort } from "./filter";

/** A single row in the org-wide Issues list. Fully serialisable (no BigInt). */
export interface IssueRow {
  id: string;
  ticketNumber: number;
  /** Human ticket key, e.g. "ACME-128" (projectKey-ticketNumber). */
  ticketKey: string;
  title: string;
  /** Status lane (board column key). */
  columnKey: string;
  priority: Priority;
  type: { id: string; key: string; name: string; icon: string | null; color: string | null };
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  /** Full assignee set (multi-assign), primary first. */
  assignees: { id: string; displayName: string; avatarUrl: string | null }[];
  /**
   * Who created the item. Resolved from the User table rather than the org
   * directory, so a person since REMOVED from the org is still named here —
   * removal is a soft delete and history has to keep reading correctly.
   * Null only if the lookup misses; `createdById` itself is non-nullable.
   */
  reporter: { id: string; displayName: string; avatarUrl: string | null } | null;
  parent: { id: string; ticketKey: string; title: string } | null;
  intervalId: string | null;
  storyPoints: number | null;
  tags: string[];
  /** Hand-set meeting callout colour; a `WORK_ITEM_HIGHLIGHTS` key or null. */
  highlight: string | null;
  /** Archived (out of the way, not deleted); null when active. */
  archivedAt: string | null;
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

  const [data, total] = await Promise.all([
    fetchIssueRows(prisma, {
      where,
      orderBy,
      skip,
      take: args.pageSize,
      orgId: args.orgId,
      allowedProjectIds: args.allowedProjectIds,
    }),
    prisma.workItem.count({ where }),
  ]);
  return { data, total };
}

/** A Prisma client or an interactive-transaction client. */
type Db = Pick<Prisma.TransactionClient, "workItem" | "project" | "user">;

/**
 * Fetch one page for an already-scoped `where` and project it to IssueRows.
 * Shared by the legacy filter path above and the CQL executor, which runs it
 * inside a transaction with a statement timeout (hence `db`).
 *
 * `allowedProjectIds` bounds the PARENT lookup: a readable child may have a
 * parent the actor cannot read, and that parent must resolve to null.
 */
export async function fetchIssueRows(
  db: Db,
  args: {
    where: Prisma.WorkItemWhereInput;
    orderBy: Prisma.WorkItemOrderByWithRelationInput[];
    skip: number;
    take: number;
    orgId: string;
    allowedProjectIds: string[];
  },
): Promise<IssueRow[]> {
  const items = await db.workItem.findMany({
    where: args.where,
    orderBy: args.orderBy,
    skip: args.skip,
    take: args.take,
    select: {
      id: true,
      ticketNumber: true,
      title: true,
      columnKey: true,
      priority: true,
      assigneeId: true,
      createdById: true,
      parentId: true,
      intervalId: true,
      storyPoints: true,
      tags: true,
      // Keep in step with `IssueRow` above AND the client-side copy in
      // issues-view.tsx. A field missing from THIS select is `undefined` at
      // runtime with a perfectly green type-check — Prisma's selected type is
      // inferred, so the interface below is a claim, not a constraint.
      highlight: true,
      archivedAt: true,
      startDate: true,
      dueDate: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      projectId: true,
      workItemType: {
        select: { id: true, key: true, name: true, icon: true, color: true },
      },
      // Multi-assign: the full set rides along so registers can render a
      // stacked-avatar cell without a second query.
      assignees: {
        orderBy: { sortOrder: "asc" },
        select: {
          userId: true,
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      },
    },
  });

  // Resolve cross-references in batch (projects, people, parents) — a flat
  // WorkItem row carries only ids.
  const projectIds = [...new Set(items.map((i) => i.projectId))];
  // Assignees and reporters resolve from the same table, so they share one
  // round-trip rather than adding a second.
  const userIds = [
    ...new Set([
      ...items.map((i) => i.assigneeId).filter((x): x is string => !!x),
      ...items.map((i) => i.createdById),
    ]),
  ];
  const parentIds = [...new Set(items.map((i) => i.parentId).filter((x): x is string => !!x))];

  const [projects, users, parents] = await Promise.all([
    projectIds.length
      ? db.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, key: true, name: true },
        })
      : Promise.resolve([]),
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          // displayName + avatarUrl only — never permissions/BigInt.
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : Promise.resolve([]),
    parentIds.length
      ? db.workItem.findMany({
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
  const userById = new Map(users.map((u) => [u.id, u]));
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const data: IssueRow[] = items.map((item) => {
    const project = projectById.get(item.projectId);
    const projectKey = project?.key ?? "";
    const assignee = item.assigneeId ? userById.get(item.assigneeId) : undefined;
    const reporter = userById.get(item.createdById);
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
      assignees: (item.assignees ?? []).map((a) => ({
        id: a.userId,
        displayName: a.user.displayName,
        avatarUrl: a.user.avatarUrl,
      })),
      reporter: reporter
        ? { id: reporter.id, displayName: reporter.displayName, avatarUrl: reporter.avatarUrl }
        : null,
      parent: parentRow
        ? {
            id: parentRow.id,
            ticketKey: `${parentKey}-${parentRow.ticketNumber}`,
            title: parentRow.title,
          }
        : null,
      intervalId: item.intervalId,
      storyPoints: item.storyPoints,
      tags: item.tags,
      highlight: item.highlight,
      archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
      startDate: item.startDate ? item.startDate.toISOString() : null,
      dueDate: item.dueDate ? item.dueDate.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  });

  return data;
}
