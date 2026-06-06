import { NextRequest } from "next/server";
import { z } from "zod";
import { ObjectiveStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

async function loadObjective(orgId: string, projectId: string, objectiveId: string) {
  return prisma.objective.findFirst({
    where: { id: objectiveId, orgId, projectId },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_READ);

    const objective = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });
    if (!objective) return new Response("Not found", { status: 404 });

    return success(objective);
  } catch (e) {
    return handleApiError(e);
  }
}

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  period: z.string().nullish(),
  status: z.nativeEnum(ObjectiveStatus).optional(),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await loadObjective(orgId, projectId, objectiveId);
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: OKR_UPDATE in the bitfield AND any narrowing deny
    // policy (by ownership / project membership). Identical to requirePermission
    // until a policy references OKR_UPDATE.
    await requireAccess(ctx, "OKR_UPDATE", {
      ownerId: existing.ownerId,
      projectId,
    });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.objective.update({
      where: { id: objectiveId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.period !== undefined && { period: data.period }),
        ...(data.status !== undefined && { status: data.status }),
      },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await loadObjective(orgId, projectId, objectiveId);
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz (OKR_DELETE + any narrowing deny policy).
    await requireAccess(ctx, "OKR_DELETE", {
      ownerId: existing.ownerId,
      projectId,
    });

    // Key results cascade-delete via the FK.
    await prisma.objective.delete({ where: { id: objectiveId } });

    return success({ id: objectiveId });
  } catch (e) {
    return handleApiError(e);
  }
}
