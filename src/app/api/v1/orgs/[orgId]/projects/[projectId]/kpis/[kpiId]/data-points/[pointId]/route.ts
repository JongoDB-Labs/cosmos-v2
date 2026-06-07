import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    kpiId: string;
    pointId: string;
  }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, kpiId, pointId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    // Scope the data point through its KPI (org + project), so cross-tenant ids fail.
    const kpi = await prisma.kpi.findFirst({
      where: { id: kpiId, orgId, projectId },
    });
    if (!kpi) return new Response("Not found", { status: 404 });

    const existing = await prisma.kpiDataPoint.findFirst({
      where: { id: pointId, kpiId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.kpiDataPoint.delete({ where: { id: pointId } });

    // Re-derive currentValue from the remaining latest reading.
    const latest = await prisma.kpiDataPoint.findFirst({
      where: { kpiId },
      orderBy: { recordedAt: "desc" },
    });
    await prisma.kpi.update({
      where: { id: kpiId },
      data: { currentValue: latest?.value ?? kpi.currentValue },
    });

    return success({ id: pointId });
  } catch (e) {
    return handleApiError(e);
  }
}
