import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { entityUrl } from "@/lib/mentions/urls";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { runWorkItemQuery, type IssueRow } from "@/lib/work-items/query/project";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { isWorkItemDone, type DoneStateColumn } from "@/lib/work-items/done-state";
import { statusLabel } from "./cards";
import type { TeamsUser } from "./identity.server";

/**
 * COSMOS-202 T1 d: what the Teams tabs show, read as the Teams user's own
 * Cosmos account. Read-only; every item links out to Cosmos. A restricted
 * item is its key and nothing else, as on the message-extension cards.
 */

export interface TabItem {
  ref: string;
  url: string;
  restricted: boolean;
  /** Absent when restricted. */
  title?: string;
  type?: string;
  project?: string;
  assignee?: string | null;
}

export interface TabGroup {
  status: string;
  items: TabItem[];
}

/** Enough for a tab; more is a sign the view should be narrower. */
export const TAB_LIMIT = 200;

async function rows(u: TeamsUser, filter: WorkItemFilter): Promise<{ rows: IssueRow[]; total: number } | null> {
  if (!hasPermission(u.auth.permissions, Permission.ITEM_READ)) return null;
  const readable = await getReadableProjectIds(u.auth);
  if (!readable.length) return { rows: [], total: 0 };
  const r = await runWorkItemQuery({
    orgId: u.orgId, allowedProjectIds: readable, filter: { archived: "active", ...filter },
    sort: { field: "updatedAt", direction: "desc" }, page: 1, pageSize: TAB_LIMIT,
  });
  return { rows: await openOnly(r.data), total: r.total };
}

/**
 * Open items only: not done (completed, or in a DONE status, the same rule as
 * everywhere else) and not cancelled (a CANCELLED status). The project's
 * workflow statuses decide, archived ones included: an item can still sit in one.
 */
async function openOnly(list: IssueRow[]): Promise<IssueRow[]> {
  const projectIds = [...new Set(list.map((r) => r.project.id))];
  const statuses = projectIds.length
    ? await prisma.workflowStatus.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, key: true, category: true } })
    : [];
  const byProject = new Map<string, DoneStateColumn[]>();
  for (const s of statuses) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), { key: s.key, category: s.category }]);
  return list.filter((r) => {
    const columns = byProject.get(r.project.id) ?? [];
    const column = columns.find((c) => c.key === r.columnKey);
    const cancelled = column ? column.category === "CANCELLED" : r.columnKey.toLowerCase() === "cancelled";
    return !cancelled && !isWorkItemDone({ columnKey: r.columnKey, completedAt: r.completedAt }, columns);
  });
}

/** Rows grouped by status, in the order statuses first appear. */
async function grouped(u: TeamsUser, list: IssueRow[], origin: string): Promise<TabGroup[]> {
  const cls = await createClassificationResolver(u.orgId);
  const groups = new Map<string, TabItem[]>();
  for (const r of list) {
    const url = `${origin}${entityUrl("workItem", { orgSlug: u.slug, id: r.ticketKey })}`;
    const restricted = cls.restricted(r.project.id, r.title);
    const item: TabItem = restricted
      ? { ref: r.ticketKey, url, restricted }
      : { ref: r.ticketKey, url, restricted, title: r.title, type: r.type.name, project: r.project.name, assignee: r.assignee?.displayName ?? null };
    // A restricted item's lane is part of what it says; it goes under its own heading.
    const status = restricted ? "Restricted" : statusLabel(r.columnKey);
    groups.set(status, [...(groups.get(status) ?? []), item]);
  }
  return [...groups].map(([status, items]) => ({ status, items }));
}

export interface TabView {
  title: string;
  groups: TabGroup[];
  /** More matched than the tab shows. */
  truncated: boolean;
}

/** "My work": open items assigned to this person. */
export async function myWork(u: TeamsUser, origin: string): Promise<TabView | null> {
  const r = await rows(u, { assigneeIds: [u.userId] });
  if (!r) return null;
  return { title: "My work", groups: await grouped(u, r.rows, origin), truncated: r.total > TAB_LIMIT };
}

/**
 * Projects a person may put on a tab: ones they can see (project visibility)
 * AND read work items from (which folds in ITEM_READ policy denies).
 */
async function tabProjectIds(u: TeamsUser): Promise<string[]> {
  if (!hasPermission(u.auth.permissions, Permission.ITEM_READ)) return [];
  const readable = await getReadableProjectIds(u.auth);
  const visible = await getVisibleProjectIds(u.auth, readable);
  return readable.filter((id) => visible.has(id));
}

/** A project's open items, for a channel tab; null when the person can't read it. */
export async function projectWork(u: TeamsUser, origin: string, projectKey: string): Promise<TabView | null> {
  const readable = await tabProjectIds(u);
  const project = await prisma.project.findFirst({
    where: { orgId: u.orgId, id: { in: readable }, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true, name: true, key: true },
  });
  if (!project) return null;
  const cls = await createClassificationResolver(u.orgId);
  const r = await rows(u, { projectIds: [project.id] });
  if (!r) return null;
  return {
    // A restricted project's name is still its own business in a shared channel.
    title: cls.restricted(project.id, project.name) ? project.key : `${project.name} (${project.key})`,
    groups: await grouped(u, r.rows, origin),
    truncated: r.total > TAB_LIMIT,
  };
}

/** Projects this person may pick for a channel tab. */
export async function tabProjects(u: TeamsUser): Promise<{ key: string; label: string }[]> {
  const readable = await tabProjectIds(u);
  if (!readable.length) return [];
  const cls = await createClassificationResolver(u.orgId);
  const projects = await prisma.project.findMany({
    where: { orgId: u.orgId, id: { in: readable }, archived: false },
    select: { id: true, key: true, name: true },
    orderBy: { name: "asc" },
  });
  return projects.map((p) => ({ key: p.key, label: cls.restricted(p.id, p.name) ? p.key : `${p.name} (${p.key})` }));
}
