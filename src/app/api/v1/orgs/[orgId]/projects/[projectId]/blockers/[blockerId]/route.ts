import { NextRequest } from "next/server";
import { z } from "zod";
import { BlockerType, BlockerStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; blockerId: string }>;
};

const blockerInclude = { programBranch: { select: { id: true, code: true, name: true } } };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  type: z.nativeEnum(BlockerType).optional(),
  branchId: z.string().uuid().nullish(),
  source: z.string().max(200).nullish(),
  identifiedBy: z.string().max(120).nullish(),
  owner: z.string().max(120).nullish(),
  whatUnblocks: z.string().nullish(),
  decisionAuthority: z.string().max(200).nullish(),
  relatedRiskCode: z.string().max(20).nullish(),
  customerNotified: z.boolean().optional(),
  customerNotifiedDate: z.string().nullish(),
  targetDate: z.string().nullish(),
  escalate: z.boolean().optional(),
  status: z.nativeEnum(BlockerStatus).optional(),
  relatedRef: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, blockerId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.blocker.findFirst({ where: { id: blockerId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.blocker.update({
      where: { id: blockerId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.source !== undefined && { source: data.source }),
        ...(data.identifiedBy !== undefined && { identifiedBy: data.identifiedBy }),
        ...(data.owner !== undefined && { owner: data.owner }),
        ...(data.whatUnblocks !== undefined && { whatUnblocks: data.whatUnblocks }),
        ...(data.decisionAuthority !== undefined && { decisionAuthority: data.decisionAuthority }),
        ...(data.relatedRiskCode !== undefined && { relatedRiskCode: data.relatedRiskCode }),
        ...(data.customerNotified !== undefined && { customerNotified: data.customerNotified }),
        ...(data.customerNotifiedDate !== undefined && {
          customerNotifiedDate: data.customerNotifiedDate ? new Date(data.customerNotifiedDate) : null,
        }),
        ...(data.targetDate !== undefined && {
          targetDate: data.targetDate ? new Date(data.targetDate) : null,
        }),
        ...(data.escalate !== undefined && { escalate: data.escalate }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.relatedRef !== undefined && { relatedRef: data.relatedRef }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
      include: blockerInclude,
    });
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, blockerId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.blocker.findFirst({ where: { id: blockerId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.blocker.delete({ where: { id: blockerId } });
    return success({ id: blockerId });
  } catch (e) {
    return handleApiError(e);
  }
}
