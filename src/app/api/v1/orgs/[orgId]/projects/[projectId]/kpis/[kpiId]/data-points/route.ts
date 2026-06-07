import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; kpiId: string }>;
};

async function loadKpi(orgId: string, projectId: string, kpiId: string) {
  return prisma.kpi.findFirst({ where: { id: kpiId, orgId, projectId } });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, kpiId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const kpi = await loadKpi(orgId, projectId, kpiId);
    if (!kpi) return new Response("Not found", { status: 404 });

    const dataPoints = await prisma.kpiDataPoint.findMany({
      where: { kpiId },
      orderBy: { recordedAt: "asc" },
    });

    return success(dataPoints);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  value: z.number(),
  recordedAt: z.coerce.date().optional(),
  note: z.string().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, kpiId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const kpi = await loadKpi(orgId, projectId, kpiId);
    if (!kpi) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());
    const recordedAt = data.recordedAt ?? new Date();

    const dataPoint = await prisma.kpiDataPoint.create({
      data: {
        kpiId,
        value: data.value,
        recordedAt,
        note: data.note ?? null,
      },
    });

    // Reflect the latest reading on the parent KPI so cards/deltas stay current.
    const latest = await prisma.kpiDataPoint.findFirst({
      where: { kpiId },
      orderBy: { recordedAt: "desc" },
    });
    if (latest) {
      await prisma.kpi.update({
        where: { id: kpiId },
        data: { currentValue: latest.value },
      });
    }

    return success(dataPoint);
  } catch (e) {
    return handleApiError(e);
  }
}
