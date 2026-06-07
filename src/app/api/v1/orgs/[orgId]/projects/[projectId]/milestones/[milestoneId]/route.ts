import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

function loadMilestone(orgId: string, projectId: string, milestoneId: string) {
  return prisma.milestone.findFirst({
    where: { id: milestoneId, orgId, projectId },
  });
}

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  dueDate: z.string().datetime().optional(),
  status: z.nativeEnum(MilestoneStatus).optional(),
  autoStatus: z.boolean().optional(),
  completedAt: z.string().datetime().nullish(),
  ownerId: z.string().uuid().nullish(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.autoStatus !== undefined && { autoStatus: data.autoStatus }),
        ...(data.completedAt !== undefined && {
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
        }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { links: true },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return new Response("Not found", { status: 404 });

    // Links cascade-delete via the FK.
    await prisma.milestone.delete({ where: { id: milestoneId } });

    return success({ id: milestoneId });
  } catch (e) {
    return handleApiError(e);
  }
}
