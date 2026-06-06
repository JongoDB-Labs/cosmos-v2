import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { CycleKind } from "@prisma/client";

const createCycleSchema = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().nullish(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  cycleKind: z.nativeEnum(CycleKind).default(CycleKind.SPRINT),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const status = request.nextUrl.searchParams.get("status");

    const cycles = await prisma.cycle.findMany({
      where: {
        orgId,
        projectId,
        ...(status && { status: status as "PLANNED" | "ACTIVE" | "COMPLETED" }),
      },
      include: {
        _count: { select: { workItems: true } },
      },
      orderBy: { number: "desc" },
    });

    return success(cycles);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_CREATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = createCycleSchema.parse(body);

    const maxNumber = await prisma.cycle.aggregate({
      where: { projectId },
      _max: { number: true },
    });
    const number = (maxNumber._max.number ?? 0) + 1;

    const cycle = await prisma.cycle.create({
      data: {
        orgId,
        projectId,
        number,
        name: data.name,
        goal: data.goal ?? "",
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        cycleKind: data.cycleKind,
      },
      include: {
        _count: { select: { workItems: true } },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "cycle.created",
      entity: "cycle",
      entityId: cycle.id,
      metadata: { name: data.name, number: String(number) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(cycle);
  } catch (error) {
    return handleApiError(error);
  }
}
