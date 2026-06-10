import { NextRequest } from "next/server";
import { z } from "zod";
import { GoalLinkKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; goalId: string }>;
};

const createLinkSchema = z
  .object({
    kind: z.nativeEnum(GoalLinkKind),
    workItemId: z.string().uuid().nullish(),
    objectiveId: z.string().uuid().nullish(),
  })
  .refine(
    (d) =>
      d.kind === GoalLinkKind.WORK_ITEM
        ? !!d.workItemId
        : !!d.objectiveId,
    { message: "workItemId is required for WORK_ITEM links; objectiveId for OBJECTIVE links" },
  );

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, goalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_UPDATE);

    const goal = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
    });
    if (!goal) return new Response("Not found", { status: 404 });

    const data = createLinkSchema.parse(await request.json());

    // Idempotent (mirrors the milestone-links route): a duplicate link would be
    // double-counted by the AUTO progress rollup, so return the existing one
    // instead of creating a second edge to the same target.
    const existing = await prisma.goalLink.findFirst({
      where: {
        goalId,
        kind: data.kind,
        ...(data.kind === GoalLinkKind.WORK_ITEM
          ? { workItemId: data.workItemId ?? null }
          : { objectiveId: data.objectiveId ?? null }),
      },
    });
    if (existing) return success(existing);

    const created = await prisma.goalLink.create({
      data: {
        goalId,
        kind: data.kind,
        workItemId:
          data.kind === GoalLinkKind.WORK_ITEM ? (data.workItemId ?? null) : null,
        objectiveId:
          data.kind === GoalLinkKind.OBJECTIVE ? (data.objectiveId ?? null) : null,
      },
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
