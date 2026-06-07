import { NextRequest } from "next/server";
import { z } from "zod";
import { KpiDirection } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const kpis = await prisma.kpi.findMany({
      where: { orgId, projectId },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });

    return success(kpis);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  unit: z.string().max(50).optional().default(""),
  targetValue: z.number().optional().default(0),
  currentValue: z.number().optional().default(0),
  direction: z.nativeEnum(KpiDirection).optional().default(KpiDirection.UP_GOOD),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    const last = await prisma.kpi.findFirst({
      where: { orgId, projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = (last?.sortOrder ?? -1) + 1;

    const created = await prisma.kpi.create({
      data: {
        orgId,
        projectId,
        name: data.name,
        description: data.description ?? null,
        unit: data.unit,
        targetValue: data.targetValue,
        currentValue: data.currentValue,
        direction: data.direction,
        sortOrder,
      },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
