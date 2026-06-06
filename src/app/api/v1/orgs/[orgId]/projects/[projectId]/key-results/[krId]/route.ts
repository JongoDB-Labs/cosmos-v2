import { NextRequest } from "next/server";
import { z } from "zod";
import { KeyResultStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; krId: string }>;
};

const updateSchema = z.object({
  currentValue: z.number().optional(),
  targetValue: z.number().optional(),
  startValue: z.number().optional(),
  title: z.string().min(1).max(200).optional(),
  unit: z.string().max(40).optional(),
  status: z.nativeEnum(KeyResultStatus).optional(),
});

/** progress% for one key result, clamped to 0-100. */
function krFraction(start: number, current: number, target: number): number {
  if (target === start) return current >= target ? 1 : 0;
  const f = (current - start) / (target - start);
  return Math.max(0, Math.min(1, f));
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Scope check: the KR's objective must belong to this org + project.
    const kr = await prisma.keyResult.findFirst({
      where: { id: krId, objective: { orgId, projectId } },
      include: { objective: { select: { projectId: true } } },
    });
    if (!kr) return new Response("Not found", { status: 404 });

    // Resource-aware authz (OKR_UPDATE + any narrowing deny policy). The KR's
    // project comes from the parent objective. Identical to requirePermission
    // until a policy references OKR_UPDATE.
    await requireAccess(ctx, "OKR_UPDATE", {
      ownerId: kr.ownerId,
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.keyResult.update({
      where: { id: krId },
      data: {
        ...(data.currentValue !== undefined && { currentValue: data.currentValue }),
        ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
        ...(data.startValue !== undefined && { startValue: data.startValue }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });

    // Recompute the parent objective's progress from all its key results.
    const siblings = await prisma.keyResult.findMany({
      where: { objectiveId: kr.objectiveId },
      select: { startValue: true, currentValue: true, targetValue: true },
    });
    const progress =
      siblings.length === 0
        ? 0
        : Math.round(
            (siblings.reduce(
              (sum, s) => sum + krFraction(s.startValue, s.currentValue, s.targetValue),
              0,
            ) /
              siblings.length) *
              100,
          );
    await prisma.objective.update({
      where: { id: kr.objectiveId },
      data: { progress },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const kr = await prisma.keyResult.findFirst({
      where: { id: krId, objective: { orgId, projectId } },
      include: { objective: { select: { projectId: true } } },
    });
    if (!kr) return new Response("Not found", { status: 404 });

    // Resource-aware authz (OKR_DELETE + any narrowing deny policy). Deleting a
    // KR requires OKR_DELETE, matching the sibling objective DELETE — a MEMBER
    // holds OKR_UPDATE but NOT OKR_DELETE and must not be able to delete KRs.
    await requireAccess(ctx, "OKR_DELETE", {
      ownerId: kr.ownerId,
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    await prisma.keyResult.delete({ where: { id: krId } });

    return success({ id: krId });
  } catch (e) {
    return handleApiError(e);
  }
}
