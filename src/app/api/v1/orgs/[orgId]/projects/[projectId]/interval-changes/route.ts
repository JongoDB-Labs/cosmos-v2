import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError } from "@/lib/api-helpers";

/**
 * Every time a work item moved between intervals in this project.
 *
 * WHY THIS IS ITS OWN ROUTE. `pm-activity` answers "what happened to THIS
 * subject" and takes a subjectType/subjectId; scope churn is a question about a
 * whole project's history, and reconstructing it by fanning that route out over
 * every work item would be hundreds of round trips to answer one chart.
 *
 * Deliberately narrow: `field = "intervalId"` only, and only the four columns
 * the chart needs. The activity table also carries titles, descriptions and
 * assignee changes; a general "give me this project's activity" endpoint would
 * hand a caller with ANALYTICS_READ far more than the analytics need. Read the
 * least that answers the question.
 */

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * A ceiling, so one enormous project cannot turn a dashboard panel into an
 * unbounded read. Reported rather than applied silently — a truncated history
 * would under-report churn, and a chart that quietly describes the most recent
 * slice while looking like it describes everything is the failure this codebase
 * keeps paying for.
 */
const MAX_CHANGES = 5000;

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ANALYTICS_READ");

    const rows = await prisma.activity.findMany({
      // Scoped through the work item's project, so an activity belonging to
      // another project in the same org can never appear here.
      where: { orgId, field: "intervalId", workItem: { projectId } },
      select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: MAX_CHANGES + 1,
    });

    const truncated = rows.length > MAX_CHANGES;
    const changes = (truncated ? rows.slice(0, MAX_CHANGES) : rows)
      // A row with no work item cannot be attributed; dropping it is right, and
      // it is not silent because `changes.length` is what the caller charts.
      .filter((r) => r.workItemId !== null)
      .map((r) => ({
        workItemId: r.workItemId as string,
        // "" and null both mean the backlog. Normalising here keeps every
        // consumer from having to know that.
        from: r.oldValue || null,
        to: r.newValue || null,
        at: r.createdAt,
      }));

    return success({ changes, truncated, limit: MAX_CHANGES });
  } catch (error) {
    return handleApiError(error);
  }
}
