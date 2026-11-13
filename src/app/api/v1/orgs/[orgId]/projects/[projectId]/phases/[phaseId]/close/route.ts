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
import { closingDecision } from "@/lib/pm/closing-evidence";
import { closingProblem, closingRuleForProject, evidenceFiles, PHASE_SELECT } from "@/lib/pm/closing-evidence.server";
import { closePhase } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; phaseId: string }> };

/**
 * Close a phase: an explicit act, never inferred from percent complete,
 * because 100% done is not the same as accepted. Under the closing rule it
 * needs a supporting file on the phase or a recorded reason.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, closePhase);
    const { params: { orgId, projectId, phaseId }, body } = await parseRequest(closePhase, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const phase = await prisma.projectPhase.findFirst({ where: { id: phaseId, orgId, projectId }, select: PHASE_SELECT });
    if (!phase) return problem(404, "not_found", undefined, { request });
    if (phase.closedAt) return problem(409, "conflict", "This phase is already closed.", { request });

    const note = body.closeEvidenceNote?.trim() || null;
    const refusal = closingDecision({
      ruleOn: await closingRuleForProject(orgId, projectId),
      wasClosed: false,
      willBeClosed: true,
      edits: false,
      files: await evidenceFiles(orgId, { phaseId }, ctx, projectId),
      note: note ?? phase.closeEvidenceNote,
    });
    if (refusal) return closingProblem(refusal, request);

    // Conditional on still being open, so two concurrent closes record one closer.
    const { count } = await prisma.projectPhase.updateMany({
      where: { id: phaseId, closedAt: null },
      data: { closedAt: new Date(), closedById: ctx.userId, ...(note !== null && { closeEvidenceNote: note }) },
    });
    if (count === 0) return problem(409, "conflict", "This phase is already closed.", { request });
    const closed = await prisma.projectPhase.findUniqueOrThrow({ where: { id: phaseId }, select: PHASE_SELECT });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "phase.closed",
      entity: "project_phase",
      entityId: phaseId,
      metadata: { projectId, name: closed.name, ...(note !== null && { closeEvidenceNote: note }) },
      ipAddress: getIpAddress(request),
    });

    return respond(closePhase, 200, { ...closed, closedAt: closed.closedAt?.toISOString() ?? null });
  } catch (error) {
    return handleApiError(error, request);
  }
}
