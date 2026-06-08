import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getReadableProjectIds } from "@/lib/work-items/query";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Filter-bar facets for the org-wide Issues view: the option lists the UI needs
 * to render its selects, all scoped to the projects the actor may read. One
 * round-trip instead of four. Never serialises OrgMember.permissions (BigInt) —
 * member options carry only id + displayName + avatarUrl.
 *
 * RBAC: mirrors the search route — gate on the raw ITEM_READ bit only (a
 * resource-less requireAccess would fail an in_project deny CLOSED and 403 the
 * whole filter bar). getReadableProjectIds folds the per-project deny in and an
 * empty readable set yields empty facets, not a 403.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
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

    if (allowedProjectIds.length === 0) {
      return success({ projects: [], types: [], statuses: [], members: [], labels: [], cycles: [] });
    }

    const [projects, types, columns, members, cycles, tagRows] = await Promise.all([
      prisma.project.findMany({
        where: { id: { in: allowedProjectIds } },
        select: { id: true, key: true, name: true, archived: true },
        orderBy: { name: "asc" },
      }),
      prisma.workItemType.findMany({
        where: { OR: [{ orgId: null }, { orgId }] },
        select: { id: true, key: true, name: true, icon: true, color: true },
        orderBy: [{ isBuiltIn: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      // Distinct status lanes available across the actor's projects' boards.
      prisma.boardColumn.findMany({
        where: { board: { projectId: { in: allowedProjectIds } } },
        select: { key: true, name: true, category: true, sortOrder: true },
        orderBy: { sortOrder: "asc" },
      }),
      prisma.orgMember.findMany({
        where: { orgId },
        select: {
          userId: true,
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { joinedAt: "asc" },
      }),
      prisma.cycle.findMany({
        where: { projectId: { in: allowedProjectIds } },
        select: { id: true, name: true, number: true, projectId: true, status: true },
        orderBy: [{ startDate: "desc" }],
      }),
      // Distinct tags in use across the actor's items (for the label filter).
      prisma.workItem.findMany({
        where: { orgId, projectId: { in: allowedProjectIds } },
        select: { tags: true },
        take: 2000,
      }),
    ]);

    // Dedup statuses by key (the same key recurs across boards/projects); keep
    // the first (lowest sortOrder) name + category as the representative label.
    const statusByKey = new Map<string, { key: string; name: string; category: string }>();
    for (const c of columns) {
      if (!statusByKey.has(c.key)) {
        statusByKey.set(c.key, { key: c.key, name: c.name, category: c.category });
      }
    }

    const labelSet = new Set<string>();
    for (const row of tagRows) {
      for (const t of row.tags) if (t) labelSet.add(t);
    }

    return success({
      projects,
      types,
      statuses: [...statusByKey.values()],
      members: members
        .filter((m) => m.user)
        .map((m) => ({
          id: m.user!.id,
          displayName: m.user!.displayName,
          avatarUrl: m.user!.avatarUrl,
        })),
      labels: [...labelSet].sort((a, b) => a.localeCompare(b)),
      cycles,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
