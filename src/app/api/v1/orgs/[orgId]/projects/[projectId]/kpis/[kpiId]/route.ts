import { NextRequest } from "next/server";
import { z } from "zod";
import { KpiDirection } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; kpiId: string }>;
};

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  unit: z.string().max(50).optional(),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  direction: z.nativeEnum(KpiDirection).optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, kpiId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.kpi.findFirst({
      where: { id: kpiId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.kpi.update({
      where: { id: kpiId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
        ...(data.currentValue !== undefined && {
          currentValue: data.currentValue,
        }),
        ...(data.direction !== undefined && { direction: data.direction }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, kpiId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.kpi.findFirst({
      where: { id: kpiId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Data points cascade-delete via the FK.
    await prisma.kpi.delete({ where: { id: kpiId } });

    return success({ id: kpiId });
  } catch (e) {
    return handleApiError(e);
  }
}
