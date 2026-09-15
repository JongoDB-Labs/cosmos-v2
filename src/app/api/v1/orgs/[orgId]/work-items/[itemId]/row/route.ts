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

    // `{itemId}` accepts a TICKET KEY as well as an id — "ACME-320" as well as
    // a uuid. A person sharing a ticket says its key; that is what is printed on
    // the card and what they can retype from memory. Requiring the internal id
    // meant the only way to hand someone a link was to read it out of network
    // traffic, which is what was reported.
    //
    // Resolution is scoped to the SAME readable projects as the query below, so
    // guessing a key cannot reach a project the caller cannot already see. A key
    // is only unique per project, so a duplicate ticket number across two
    // readable projects is deliberately not resolved — better no answer than a
    // silent guess at which one was meant.
    let resolvedId = itemId;
    const key = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(itemId.trim());
    if (key) {
      // Two steps, because WorkItem has no `project` RELATION — only the
      // scalar projectId — so the key cannot be matched in one where clause.
      // (tsc is blind to this; it only showed up on a real request.)
      const projects = await prisma.project.findMany({
        where: {
          orgId,
          id: { in: allowedProjectIds },
          key: { equals: key[1], mode: "insensitive" },
        },
        select: { id: true },
        take: 2,
      });
      if (projects.length !== 1) return new Response("Not found", { status: 404 });
      const match = await prisma.workItem.findFirst({
        where: {
          orgId,
          projectId: projects[0].id,
          ticketNumber: Number(key[2]),
        },
        select: { id: true },
      });
      if (!match) return new Response("Not found", { status: 404 });
      resolvedId = match.id;
    }

    const result = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter: { ids: [resolvedId] },
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
