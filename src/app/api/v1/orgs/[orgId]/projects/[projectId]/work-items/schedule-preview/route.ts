import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { ProblemError } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { previewSchedule as planPreview } from "@/lib/work-items/schedule-preview.server";
import { collectPluginImpact } from "@/lib/plugins/schedule-impact.server";
import { previewSchedule } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * The Gantt's confirm step: what a reschedule would do, before it is saved.
 * Writes nothing. Checked exactly as the save is (project first, then
 * ITEM_UPDATE on each item), so the preview never describes a change the
 * caller could not make, and never confirms an item in a project they can't see.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, previewSchedule);
    const { params: { orgId, projectId }, body } = await parseRequest(previewSchedule, request, params);
    await requireProjectRead(ctx, projectId, "ITEM_UPDATE");

    const ids = body.changes.map((c) => c.id);
    const existing = await prisma.workItem.findMany({
      where: { id: { in: ids }, orgId, projectId, archivedAt: null },
      select: { id: true, createdById: true, assigneeId: true },
    });
    if (existing.length !== ids.length) throw new ProblemError(404, "not_found");
    for (const it of existing) {
      await requireAccess(ctx, "ITEM_UPDATE", { createdById: it.createdById, assigneeId: it.assigneeId, projectId });
    }

    const core = await planPreview(prisma, { orgId, projectId, input: body.changes });
    if (core.missing.length > 0) throw new ProblemError(404, "not_found");

    const sections = await collectPluginImpact({
      orgId,
      projectId,
      userId: ctx.userId,
      auth: ctx,
      changes: core.changes,
      cascaded: core.cascaded,
    });

    const needsConfirm =
      core.cascaded.length > 0 ||
      core.allocation.some((a) => a.peakAfter > a.peakBefore && a.peakAfter > 1) ||
      sections.length > 0;

    return respond(previewSchedule, 200, {
      changes: core.changes,
      cascaded: core.cascaded,
      allocation: core.allocation,
      sections,
      needsConfirm,
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}
