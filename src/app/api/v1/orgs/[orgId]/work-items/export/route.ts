import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import {
  getReadableProjectIds,
  parseSearchParams,
  runWorkItemQuery,
} from "@/lib/work-items/query";
import { issueToCosmosItem, serializeCosmosCsv } from "@/lib/export/cosmos-schema";

type RouteParams = { params: Promise<{ orgId: string }> };

const csvHeaders = (slug: string) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="issues-${slug}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv"`,
});

/**
 * GET — export the actor's readable work items as a CSV download. Mirrors the
 * Issues view's RBAC-scoped search (same `?filter` params → "export what you
 * see"), then projects each row onto the common Cosmos item schema (see
 * `@/lib/export/cosmos-schema`) with resolved type / project / assignee / parent
 * names — the same schema the unified `/export/cosmos` endpoint uses, so an
 * issue reads identically whether exported on its own or alongside OKRs,
 * milestones, and sprints. The same scoping as `/work-items/search` guarantees a
 * user can never export items from a project they can't read.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Org-level read gate (raw bit); per-project narrowing happens in
    // getReadableProjectIds, exactly like the search route.
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Bulk export is an exfil-shaped action — rate-limit like the other exporters.
    const limited = checkRateLimit(request, "export.issues.csv", ctx.userId, {
      capacity: 10,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) {
      // Header-only CSV (still well-formed) rather than an empty body.
      return new Response(serializeCosmosCsv([]), { status: 200, headers: csvHeaders(org.slug) });
    }

    const { filter, sort } = parseSearchParams(request.nextUrl.searchParams);
    // pageSize is passed straight to the query (the parse-time MAX cap doesn't
    // apply here) so the export isn't silently truncated to one UI page.
    const { data } = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter,
      sort,
      page: 1,
      pageSize: 50_000,
    });

    // Project each work item onto the common Cosmos schema (one row per item).
    const items = data.map((r) =>
      issueToCosmosItem({
        id: r.id,
        ticketKey: r.ticketKey,
        title: r.title,
        typeName: r.type.name,
        columnKey: r.columnKey,
        priority: r.priority,
        assigneeName: r.assignee?.displayName ?? null,
        projectName: r.project.name,
        parentKey: r.parent?.ticketKey ?? null,
        storyPoints: r.storyPoints,
        tags: r.tags,
        startDate: r.startDate,
        dueDate: r.dueDate,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );

    return new Response(serializeCosmosCsv(items), { status: 200, headers: csvHeaders(org.slug) });
  } catch (e) {
    return handleApiError(e);
  }
}
