import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { SprintStatus } from "@prisma/client";

const updateCycleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().nullish(),
  startDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
  status: z.nativeEnum(SprintStatus).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; cycleId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, cycleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_READ);

    const cycle = await prisma.cycle.findFirst({
      where: { id: cycleId, projectId, orgId },
      include: {
        workItems: {
          include: {
            _count: { select: { comments: true } },
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        },
        _count: { select: { workItems: true } },
      },
    });

    if (!cycle) return new Response("Not found", { status: 404 });

    return success(cycle);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, cycleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_UPDATE);

    const existing = await prisma.cycle.findFirst({ where: { id: cycleId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateCycleSchema.parse(body);

    if (data.status === "ACTIVE") {
      const activeCycle = await prisma.cycle.findFirst({
        where: { projectId, status: "ACTIVE", id: { not: cycleId } },
      });
      if (activeCycle) {
        return new Response(
          JSON.stringify({ error: "Another cycle is already active" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const updated = await prisma.cycle.update({
      where: { id: cycleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.goal !== undefined && { goal: data.goal ?? "" }),
        ...(data.startDate !== undefined && data.startDate !== null && { startDate: new Date(data.startDate) }),
        ...(data.endDate !== undefined && data.endDate !== null && { endDate: new Date(data.endDate) }),
        ...(data.status !== undefined && { status: data.status }),
      },
      include: { _count: { select: { workItems: true } } },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "cycle.updated",
      entity: "cycle",
      entityId: cycleId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, cycleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_UPDATE);

    const existing = await prisma.cycle.findFirst({ where: { id: cycleId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    if (existing.status === "ACTIVE") {
      return new Response(
        JSON.stringify({ error: "Cannot delete an active cycle. Complete it first." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.$transaction([
      prisma.workItem.updateMany({
        where: { cycleId },
        data: { cycleId: null },
      }),
      prisma.cycle.delete({ where: { id: cycleId } }),
    ]);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "cycle.deleted",
      entity: "cycle",
      entityId: cycleId,
      metadata: { name: existing.name, number: String(existing.number) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
