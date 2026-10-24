import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { ProblemError } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { previewSchedule as planPreview } from "@/lib/work-items/schedule-preview.server";
import { collectPluginImpact, unknownPluginKinds } from "@/lib/plugins/schedule-impact.server";
import { WORK_ITEM_KIND } from "@/lib/work-items/schedule-impact";
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

    const items = body.changes.filter((c) => (c.kind ?? WORK_ITEM_KIND) === WORK_ITEM_KIND);
    const pluginChanges = body.changes
      .filter((c) => (c.kind ?? WORK_ITEM_KIND) !== WORK_ITEM_KIND)
      .map((c) => ({ kind: c.kind!, id: c.id, startDate: c.startDate, dueDate: c.dueDate }));
    // A plugin kind must belong to an enabled plugin that previews schedules:
    // never address a change to a plugin that isn't there to check it.
    const unknown = await unknownPluginKinds(orgId, pluginChanges.map((c) => c.kind));
    if (unknown.length > 0) throw new ProblemError(400, "invalid_request", `Unknown change kind: ${unknown.join(", ")}`);

    const ids = items.map((c) => c.id);
    const existing = await prisma.workItem.findMany({
      where: { id: { in: ids }, orgId, projectId, archivedAt: null },
      select: { id: true, createdById: true, assigneeId: true },
    });
    if (existing.length !== ids.length) throw new ProblemError(404, "not_found");
    for (const it of existing) {
      await requireAccess(ctx, "ITEM_UPDATE", { createdById: it.createdById, assigneeId: it.assigneeId, projectId });
    }

    const core = await planPreview(prisma, { orgId, projectId, input: items });
    if (core.missing.length > 0) throw new ProblemError(404, "not_found");

    const sections = await collectPluginImpact({
      orgId,
      projectId,
      userId: ctx.userId,
      auth: ctx,
      changes: core.changes,
      cascaded: core.cascaded,
      pluginChanges,
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
