import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { PHASE_SELECT } from "@/lib/pm/closing-evidence.server";
import { reopenPhase } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; phaseId: string }> };

/**
 * Reopen a closed phase: the way back from read-only. Clears who closed it and
 * when (the audit log keeps both), and keeps the recorded reason, so closing
 * it again doesn't ask twice.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, reopenPhase);
    const { params: { orgId, projectId, phaseId } } = await parseRequest(reopenPhase, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const phase = await prisma.projectPhase.findFirst({ where: { id: phaseId, orgId, projectId }, select: PHASE_SELECT });
    if (!phase) return problem(404, "not_found", undefined, { request });
    if (!phase.closedAt) return problem(409, "conflict", "This phase isn't closed.", { request });

    const reopened = await prisma.projectPhase.update({
      where: { id: phaseId },
      data: { closedAt: null, closedById: null },
      select: PHASE_SELECT,
    });
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "phase.reopened",
      entity: "project_phase",
      entityId: phaseId,
      metadata: {
        projectId,
        name: reopened.name,
        wasClosedAt: phase.closedAt.toISOString(),
        wasClosedBy: phase.closedById ?? "",
      },
      ipAddress: getIpAddress(request),
    });
    return respond(reopenPhase, 200, { ...reopened, closedAt: null });
  } catch (error) {
    return handleApiError(error, request);
  }
}
