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
import { toCSV } from "@/lib/export/csv";

type RouteParams = { params: Promise<{ orgId: string }> };

const csvHeaders = (slug: string) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="issues-${slug}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv"`,
});

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * GET — export the actor's readable work items as a CSV download. Mirrors the
 * Issues view's RBAC-scoped search (same `?filter` params → "export what you
 * see"), then projects each row onto a clean, human-readable schema (resolved
 * type / project / assignee / parent names, not raw ids). The same scoping as
 * `/work-items/search` guarantees a user can never export items from a project
 * they can't read.
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
      return new Response("", { status: 200, headers: csvHeaders(org.slug) });
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

    // Clean, common schema across the export (one row per work item).
    const rows = data.map((r) => ({
      Ticket: r.ticketKey,
      Title: r.title,
      Type: r.type.name,
      Status: r.columnKey,
      Priority: r.priority,
      Project: r.project.name,
      Assignee: r.assignee?.displayName ?? "",
      "Story Points": r.storyPoints ?? "",
      Parent: r.parent?.ticketKey ?? "",
      Tags: r.tags.join("; "),
      "Start Date": day(r.startDate),
      "Due Date": day(r.dueDate),
      Completed: day(r.completedAt),
      Created: day(r.createdAt),
      Updated: day(r.updatedAt),
    }));

    return new Response(toCSV(rows), { status: 200, headers: csvHeaders(org.slug) });
  } catch (e) {
    return handleApiError(e);
  }
}
