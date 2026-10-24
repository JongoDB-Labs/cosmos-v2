import { NextRequest } from "next/server";
import { RagStatus, KeyResultStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { requireAccess } from "@/lib/abac/require-access";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { ForbiddenError } from "@/lib/rbac/check";
import { handleApiError } from "@/lib/api-helpers";
import { krFraction } from "@/lib/okr/progress";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createCheckin, listCheckins } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { idempotent } from "@/lib/openapi/idempotency";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; krId: string }>;
};

// The stoplight is the primary health signal; keep the legacy KeyResultStatus in
// step so existing views/filters stay meaningful (no BEHIND value — RED maps to
// AT_RISK, the strongest "needs attention" status available).
const RAG_TO_STATUS: Record<RagStatus, KeyResultStatus> = {
  GREEN: KeyResultStatus.ON_TRACK,
  YELLOW: KeyResultStatus.AT_RISK,
  RED: KeyResultStatus.AT_RISK,
};

async function loadScopedKr(orgId: string, projectId: string, krId: string) {
  return prisma.keyResult.findFirst({
    where: { id: krId, objective: { orgId, projectId } },
    include: { objective: { select: { projectId: true } } },
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listCheckins);
    const { params: { orgId, projectId, krId } } = await parseRequest(listCheckins, request, params);

    const kr = await loadScopedKr(orgId, projectId, krId);
    if (!kr) return problem(404, "not_found", undefined, { request });

    // NOT `requireProjectRead` here: it rebuilds the attribute bag as
    // `{orgId, projectId}` and would DROP `objectiveId`, weakening any ABAC
    // policy written against a specific objective. So the two halves are done
    // explicitly — the richer requireAccess, then the same team-scoping check
    // requireProjectRead performs — which is equivalent for visibility and
    // strictly stronger for policy.
    await requireAccess(ctx, "OKR_READ", {
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });
    if (!(await isProjectVisible(ctx, kr.objective.projectId))) {
      throw new ForbiddenError("Access denied by policy");
    }

    const checkins = await prisma.keyResultCheckin.findMany({
      where: { keyResultId: krId },
      orderBy: { createdAt: "desc" },
    });
    return respond(listCheckins, 200, checkins);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createCheckin);
    const { params: { orgId, projectId, krId }, body: data } = await parseRequest(createCheckin, request, params);
    await requireProjectVisible(ctx, projectId);
    return await idempotent({ request, ctx, orgId, body: data }, async () => {

      const kr = await loadScopedKr(orgId, projectId, krId);
      if (!kr) return problem(404, "not_found", undefined, { request });

      await requireAccess(ctx, "OKR_UPDATE", {
        ownerId: kr.ownerId,
        projectId: kr.objective.projectId,
        objectiveId: kr.objectiveId,
      });

      const checkin = await prisma.keyResultCheckin.create({
        data: {
          keyResultId: krId,
          value: data.value,
          confidence: data.confidence,
          rag: data.rag,
          note: data.note ?? null,
          blockers: data.blockers ?? null,
          checkedInById: ctx.userId,
        },
      });

      // Fold the check-in into the KR's live snapshot (value + latest confidence/rag
      // + a matching status), then recompute the parent objective's progress.
      await prisma.keyResult.update({
        where: { id: krId },
        data: {
          currentValue: data.value,
          confidence: data.confidence,
          rag: data.rag,
          status: RAG_TO_STATUS[data.rag],
        },
      });

      const siblings = await prisma.keyResult.findMany({
        where: { objectiveId: kr.objectiveId },
        select: { startValue: true, currentValue: true, targetValue: true, lowerIsBetter: true },
      });
      const progress =
        siblings.length === 0
          ? 0
          : Math.round(
              (siblings.reduce(
                (sum, s) => sum + krFraction(s.startValue, s.currentValue, s.targetValue, s.lowerIsBetter),
                0,
              ) /
                siblings.length) *
                100,
            );
      await prisma.objective.update({
        where: { id: kr.objectiveId },
        data: { progress },
      });

      return respond(createCheckin, 201, checkin);
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
