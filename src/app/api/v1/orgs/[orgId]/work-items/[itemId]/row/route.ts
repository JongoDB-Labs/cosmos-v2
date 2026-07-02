import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getReadableProjectIds, runWorkItemQuery } from "@/lib/work-items/query";

type RouteParams = { params: Promise<{ orgId: string; itemId: string }> };

/**
 * A single work item in the IssueRow shape (same projection/RBAC scoping as the
 * org-wide search). Lets the Issues view open the detail sheet from a deep-link
 * (`/issues?item=<id>`) even when the item isn't on the current page. Returns
 * 404 when the item is outside the caller's readable projects.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) {
      return new Response("Not found", { status: 404 });
    }

    const result = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter: { ids: [itemId] },
      sort: undefined,
      page: 1,
      pageSize: 1,
    });
    const row = result.data[0];
    if (!row) return new Response("Not found", { status: 404 });
    return success(row);
  } catch (error) {
    return handleApiError(error);
  }
}
