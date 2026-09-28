import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { readableTimeUserIds } from "@/lib/time/scope";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { mergePage, decodeCursor, type FeedItem } from "@/lib/activity/merge";
import type { AuthContext } from "@/lib/rbac/check";

type RouteParams = { params: Promise<{ orgId: string }> };

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const EMPTY = { data: [], nextCursor: null as string | null };

/**
 * Org-wide "who did what, when" (FR 8aa3c0e0).
 *
 * TWO SOURCES, EACH GATED ON ITS OWN TERMS. Work-item activity needs ITEM_READ
 * and is narrowed by `getReadableProjectIds`; logged time needs TIME_READ and is
 * narrowed by `readableTimeUserIds` — self plus direct reports, or everybody for
 * a TIME_READ_ALL holder. A reader holding one permission and not the other sees
 * that half of the feed and no trace of the other, rather than a 403 or, worse,
 * somebody else's hours. Only a reader with NEITHER is refused.
 *
 * The two sources measure "when" on different clocks on purpose: a work item
 * changed at an INSTANT, an hour was worked on a DAY. Both answer "when it
 * happened", which is the question the feed asks.
 *
 * Filters (all optional, AND-combined): `projectId`, `type` (work-item type id),
 * `action`, `userId` (the actor), `sources` (`work`, `time`, or both). Cursor
 * pagination is `<at>|<id>` — see `lib/activity/merge` for why the id is in
 * there, and what happens to a bulk import without it.
 */

type Actor = { id: string; displayName: string | null; avatarUrl: string | null };

type FeedRow = FeedItem & {
  kind: "work-item" | "time";
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  userId: string;
  item: {
    id: string;
    ticketKey: string;
    ticketNumber: number;
    title: string;
    columnKey: string | null;
    project: { id: string; key: string; name: string };
    type: { id: string; name: string; icon: string | null; color: string | null } | null;
  } | null;
  time: {
    hours: number;
    date: string;
    description: string;
    billableType: string;
    project: { id: string; key: string; name: string } | null;
  } | null;
};

/** Work-item activity, already narrowed to the projects this actor may read. */
async function workItemEvents(
  orgId: string,
  ctx: AuthContext,
  sp: URLSearchParams,
  limit: number,
): Promise<FeedRow[]> {
  if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) return [];

  const allowedProjectIds = await getReadableProjectIds(ctx);
  if (allowedProjectIds.length === 0) return [];

  const projectFilter = sp.get("projectId");
  const typeFilter = sp.get("type");
  const actionFilter = sp.get("action");
  const userFilter = sp.get("userId");

  // A projectId filter must stay within the readable set (a request for a
  // project the actor can't read yields nothing, never a leak).
  const projectScope =
    projectFilter && allowedProjectIds.includes(projectFilter)
      ? [projectFilter]
      : projectFilter
        ? [] // asked for a project they can't read
        : allowedProjectIds;
  if (projectScope.length === 0) return [];

  const items = await prisma.workItem.findMany({
    where: {
      orgId,
      projectId: { in: projectScope },
      ...(typeFilter ? { workItemTypeId: typeFilter } : {}),
    },
    select: {
      id: true,
      ticketNumber: true,
      title: true,
      columnKey: true,
      projectId: true,
      workItemType: { select: { id: true, name: true, icon: true, color: true } },
    },
  });
  if (items.length === 0) return [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.projectId))] } },
    select: { id: true, key: true, name: true },
  });
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Over-fetch by the page size rather than cursoring in SQL: the merge decides
  // what survives, and a source that cursored itself would hand back a page
  // that the other source then pushes off the end.
  const activities = await prisma.activity.findMany({
    where: {
      orgId,
      workItemId: { in: [...itemById.keys()] },
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(userFilter ? { userId: userFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  return activities.map((a) => {
    const item = a.workItemId ? itemById.get(a.workItemId) : undefined;
    const project = item ? projectById.get(item.projectId) : undefined;
    return {
      at: a.createdAt.toISOString(),
      id: a.id,
      kind: "work-item" as const,
      action: a.action,
      field: a.field,
      oldValue: a.oldValue,
      newValue: a.newValue,
      createdAt: a.createdAt.toISOString(),
      userId: a.userId,
      item:
        item && project
          ? {
              id: item.id,
              ticketKey: `${project.key}-${item.ticketNumber}`,
              ticketNumber: item.ticketNumber,
              title: item.title,
              columnKey: item.columnKey,
              project,
              type: item.workItemType,
            }
          : null,
      time: null,
    };
  });
}

/** Hours logged, narrowed to the people whose time this actor may read. */
async function timeEvents(
  orgId: string,
  ctx: AuthContext,
  sp: URLSearchParams,
  limit: number,
): Promise<FeedRow[]> {
  if (!hasPermission(ctx.permissions, Permission.TIME_READ)) return [];

  const allowed = await readableTimeUserIds(ctx); // null = may read everybody
  const userFilter = sp.get("userId");
  if (userFilter && allowed !== null && !allowed.includes(userFilter)) return [];

  const projectFilter = sp.get("projectId");
  // A type filter is a work-item notion; asking for one excludes time entirely
  // rather than quietly ignoring the filter.
  if (sp.get("type")) return [];

  const entries = await prisma.timeEntry.findMany({
    where: {
      orgId,
      ...NOT_VOIDED,
      status: { not: "DRAFT" },
      ...(allowed !== null ? { userId: { in: allowed } } : {}),
      ...(userFilter ? { userId: userFilter } : {}),
      ...(projectFilter ? { projectId: projectFilter } : {}),
    },
    select: {
      id: true,
      userId: true,
      date: true,
      hours: true,
      description: true,
      billableType: true,
      projectId: true,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  if (entries.length === 0) return [];

  const projectIds = [...new Set(entries.map((e) => e.projectId).filter(Boolean))] as string[];
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, key: true, name: true },
      })
    : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return entries.map((e) => {
    const at = e.date.toISOString();
    return {
      at,
      id: e.id,
      kind: "time" as const,
      action: "logged",
      field: null,
      oldValue: null,
      newValue: null,
      createdAt: at,
      userId: e.userId,
      item: null,
      time: {
        hours: e.hours,
        date: at.slice(0, 10),
        description: e.description,
        billableType: e.billableType,
        project: e.projectId ? (projectById.get(e.projectId) ?? null) : null,
      },
    };
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const canItems = hasPermission(ctx.permissions, Permission.ITEM_READ);
    const canTime = hasPermission(ctx.permissions, Permission.TIME_READ);
    // Refused only when there is no half of the feed they could read.
    if (!canItems && !canTime) return new Response("Forbidden", { status: 403 });

    const sp = request.nextUrl.searchParams;
    const limit = Math.min(
      Math.max(Number(sp.get("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const cursor = decodeCursor(sp.get("cursor"));
    const wanted = (sp.get("sources") ?? "work,time").split(",").map((x) => x.trim());

    const [work, time] = await Promise.all([
      wanted.includes("work") ? workItemEvents(orgId, ctx, sp, limit) : [],
      wanted.includes("time") ? timeEvents(orgId, ctx, sp, limit) : [],
    ]);

    const { page, nextCursor } = mergePage<FeedRow>([work, time], limit, cursor);
    if (page.length === 0) return success(EMPTY);

    // One batch for every actor on the merged page.
    const userIds = [...new Set(page.map((r) => r.userId))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const userById = new Map<string, Actor>(users.map((u) => [u.id, u]));

    const data = page.map((r) => ({
      id: r.id,
      kind: r.kind,
      action: r.action,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt,
      actor: userById.get(r.userId) ?? {
        id: r.userId,
        displayName: "Unknown",
        avatarUrl: null,
      },
      item: r.item,
      time: r.time,
    }));

    return success({ data, nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}
