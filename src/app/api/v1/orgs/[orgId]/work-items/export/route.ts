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
  unknownQueryParams,
} from "@/lib/work-items/query";
import { toCSV } from "@/lib/export/csv";
import { classificationApplies } from "@/lib/compliance/classification";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { rankOf } from "@/lib/classification/effective";
import { classificationLabel, isMarkingLevel } from "@/lib/classification/levels";
import { logAudit } from "@/lib/audit";
import { cqlEnabled } from "@/lib/query/flag";
import { exportCql } from "@/lib/query/execute.server";
import { cqlErrorResponse, cqlTooLong } from "@/lib/query/route.server";
import type { ClassificationLevel } from "@prisma/client";

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
 *
 * `?cql=` (where the org has CQL on) exports what a CQL query matches, the same
 * rows the Issues view shows for it; it replaces the other filter parameters.
 *
 * Classification (GOV tenants only; a COMMERCIAL export carries no marking at
 * all, per `classificationApplies`). Each row gets a Classification column: its
 * project's effective ceiling, raised to CUI when its own title or tags carry a
 * marking (`createClassificationResolver`, the calendar feed's rule). The file
 * as a whole is handled at the highest of those levels and the org ceiling.
 * When that is a marking level the export:
 *   - requires ORG_EXPORT, because a file of controlled data leaving the system
 *     is a dissemination decision, not a read;
 *   - carries the banner as its first and last line, so the marking travels
 *     with the file wherever it is opened or forwarded;
 *   - is audited (`work_items.export.classified`).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const sp = request.nextUrl.searchParams;
    const cqlOn = cqlEnabled(org.settings);
    // Without the query language `?cql=` doesn't exist here: 404, as on search.
    if (!cqlOn && sp.has("cql")) return new Response("Not found", { status: 404 });

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

    const cql = cqlOn ? sp.get("cql") : null;
    let data: Awaited<ReturnType<typeof runWorkItemQuery>>["data"];
    if (cql !== null) {
      const others = [...new Set(sp.keys())].filter((k) => k !== "cql" && k !== "tz");
      if (others.length > 0) {
        return new Response(
          JSON.stringify({ error: "`cql` replaces the other filter parameters", unknown: others }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const tooLong = cqlTooLong(cql);
      if (tooLong) return tooLong;
      // No early "nothing readable" answer: bad CQL is a 400 for everyone.
      try {
        ({ data } = await exportCql(ctx, { cql }, { tz: sp.get("tz") ?? undefined }));
      } catch (e) {
        return cqlErrorResponse(e);
      }
    } else {
      const allowedProjectIds = await getReadableProjectIds(ctx);
      if (allowedProjectIds.length === 0) {
        return new Response("", { status: 200, headers: csvHeaders(org.slug) });
      }

      // Reject parameters nothing will read, rather than answering as if they
      // had been applied. A filter that silently does not filter returns
      // plausible WRONG answers, which costs the caller more than an error.
      const unknown = unknownQueryParams(request.nextUrl.searchParams);
      if (unknown.length > 0) {
        return new Response(
          JSON.stringify({
            error: "Unknown query parameter",
            unknown,
            hint:
              "Unrecognised parameters are not applied, so this request would have "
              + "returned an unfiltered page. Check the spelling against the supported filters.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { filter, sort } = parseSearchParams(request.nextUrl.searchParams);
      // pageSize is passed straight to the query (the parse-time MAX cap doesn't
      // apply here) so the export isn't silently truncated to one UI page.
      ({ data } = await runWorkItemQuery({
        orgId,
        allowedProjectIds,
        filter,
        sort,
        page: 1,
        pageSize: 50_000,
      }));
    }

    const marking = classificationApplies(org.tenantClass)
      ? await createClassificationResolver(orgId)
      : null;
    const levels = marking
      ? data.map((r) => marking.rowLevel(r.project.id, r.title, ...r.tags))
      : [];
    const fileLevel: ClassificationLevel | null = marking
      ? levels.reduce((max, l) => (rankOf(l) > rankOf(max) ? l : max), marking.orgLevel)
      : null;

    // Clean, common schema across the export (one row per work item).
    const rows = data.map((r, i) => ({
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
      ...(marking ? { Classification: classificationLabel(levels[i]) } : {}),
    }));

    if (fileLevel === null || !isMarkingLevel(fileLevel)) {
      return new Response(toCSV(rows), { status: 200, headers: csvHeaders(org.slug) });
    }

    if (!hasPermission(ctx.permissions, Permission.ORG_EXPORT)) {
      // Plain text, not JSON: the Issues "Export CSV" button is a plain link,
      // so a refusal is read in a browser tab as often as by an API client.
      return new Response(
        `This export contains ${classificationLabel(fileLevel)} information. `
          + "Exporting it requires the Org export permission. "
          + "Narrow the filter to unmarked projects, or ask an administrator.",
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_items.export.classified",
      entity: "work_item",
      metadata: { level: fileLevel, rows: rows.length },
    });
    const banner = classificationLabel(fileLevel).toUpperCase();
    return new Response(`${banner}\n${toCSV(rows)}\n${banner}`, {
      status: 200,
      headers: { ...csvHeaders(org.slug), "X-Classification": banner },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
