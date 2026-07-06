import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

type RouteParams = { params: Promise<{ orgId: string }> };

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const EMPTY = { data: [], nextCursor: null as string | null };

/**
 * Org-wide "latest updates" activity feed (FR 8aa3c0e0). A single reverse-chron
 * stream of work-item activity across every project the actor may read — so a
 * PM can see what moved without opening each ticket.
 *
 * Auth mirrors the Issues search route: the raw ITEM_READ bit gates entry, then
 * `getReadableProjectIds` narrows to the projects the actor can read (folding in
 * any `in_project` ITEM_READ deny). Activity for work items outside that set is
 * never returned.
 *
 * Filters (all optional, AND-combined): `projectId`, `type` (work-item type id),
 * `action` (created/updated/…), `userId` (the actor). Cursor pagination is
 * keyed on the activity's `createdAt` (ISO) — pass the previous page's
 * `nextCursor` to continue. Activities carry no projectId/type of their own, so
 * those filters resolve to a work-item id set first, then constrain the feed.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) return success(EMPTY);

    const sp = request.nextUrl.searchParams;
    const projectFilter = sp.get("projectId");
    const typeFilter = sp.get("type");
    const actionFilter = sp.get("action");
    const userFilter = sp.get("userId");
    const cursor = sp.get("cursor");
    const limit = Math.min(
      Math.max(Number(sp.get("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    // The feed is work-item activity, so scope the underlying work items first.
    // A projectId filter must stay within the readable set (a request for a
    // project the actor can't read yields nothing, never a leak).
    const projectScope =
      projectFilter && allowedProjectIds.includes(projectFilter)
        ? [projectFilter]
        : projectFilter
          ? [] // asked for a project they can't read
          : allowedProjectIds;
    if (projectScope.length === 0) return success(EMPTY);

    // Resolve the visible work-item id set. When neither project nor type
    // narrows below the full readable set we still need the id list to constrain
    // activities (they have no projectId column); it's one indexed query.
    //
    // Scale note: this loads the readable item-id set to build the activity
    // WHERE. Fine at current scale (100s of items); if an org grows to many
    // thousands, add a projectId column to `activities` (or an `[orgId,
    // createdAt]` index + post-filter) so the feed doesn't materialize every id.
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
    if (items.length === 0) return success(EMPTY);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // WorkItem has no `project` relation (projects are resolved by id across the
    // codebase); batch-fetch the ones in play for ticket keys + labels.
    const projects = await prisma.project.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.projectId))] } },
      select: { id: true, key: true, name: true },
    });
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const activities = await prisma.activity.findMany({
      where: {
        orgId,
        workItemId: { in: [...itemById.keys()] },
        ...(actionFilter ? { action: actionFilter } : {}),
        ...(userFilter ? { userId: userFilter } : {}),
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1, // one extra to detect the next page
    });

    const hasMore = activities.length > limit;
    const page = hasMore ? activities.slice(0, limit) : activities;

    // Resolve actor display names in one batch.
    const userIds = [...new Set(page.map((a) => a.userId))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const data = page.map((a) => {
      const item = a.workItemId ? itemById.get(a.workItemId) : undefined;
      const project = item ? projectById.get(item.projectId) : undefined;
      const actor = userById.get(a.userId);
      return {
        id: a.id,
        action: a.action,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        createdAt: a.createdAt.toISOString(),
        actor: actor
          ? { id: actor.id, displayName: actor.displayName, avatarUrl: actor.avatarUrl }
          : { id: a.userId, displayName: "Unknown", avatarUrl: null },
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
      };
    });

    return success({
      data,
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
