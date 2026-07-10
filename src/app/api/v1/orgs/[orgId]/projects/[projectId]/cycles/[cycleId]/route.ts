import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { SprintStatus, Prisma } from "@prisma/client";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";

const updateCycleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().nullish(),
  startDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
  status: z.nativeEnum(SprintStatus).optional(),
  // Program Increment to nest this sprint under (a PI cycle id), or null to
  // detach it back to top level. Validated same-project + must be a PI.
  parentId: z.string().uuid().nullable().optional(),
  // Planning snapshot captured when a sprint is started (sprint-planning flow):
  // the team's commitment + capacity at kickoff, stashed in `report.plan` so the
  // end-of-sprint review can show committed-vs-delivered. Non-completion writes.
  plan: z
    .object({
      committedPoints: z.number().nonnegative().max(100_000),
      capacityHours: z.number().nonnegative().max(1_000_000),
      plannedAt: z.string().datetime().optional(),
    })
    .nullish(),
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

    // Validate a PI re-parent: target must be a PROGRAM_INCREMENT in this
    // project, and a cycle can't be its own parent (no 1-level self-nesting).
    if (data.parentId !== undefined && data.parentId !== null) {
      if (data.parentId === cycleId) {
        return new Response(JSON.stringify({ error: "A cycle can't be its own Program Increment" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const parent = await prisma.cycle.findFirst({
        where: { id: data.parentId, projectId },
        select: { cycleKind: true },
      });
      if (!parent || parent.cycleKind !== "PROGRAM_INCREMENT") {
        return new Response(
          JSON.stringify({ error: "A sprint can only be nested under a Program Increment" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

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

    // Merge a planning snapshot into `report.plan` without clobbering any
    // existing completion metrics stored there.
    let reportUpdate: Record<string, unknown> | undefined;
    if (data.plan !== undefined) {
      const prevReport =
        existing.report && typeof existing.report === "object" && !Array.isArray(existing.report)
          ? (existing.report as Record<string, unknown>)
          : {};
      reportUpdate =
        data.plan === null
          ? (() => {
              const { plan: _drop, ...rest } = prevReport;
              void _drop;
              return rest;
            })()
          : { ...prevReport, plan: { ...data.plan, plannedAt: data.plan.plannedAt ?? new Date().toISOString() } };
    }

    const updated = await prisma.cycle.update({
      where: { id: cycleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.goal !== undefined && { goal: data.goal ?? "" }),
        ...(data.startDate !== undefined && data.startDate !== null && { startDate: new Date(data.startDate) }),
        ...(data.endDate !== undefined && data.endDate !== null && { endDate: new Date(data.endDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
        ...(reportUpdate !== undefined && { report: reportUpdate as Prisma.InputJsonValue }),
      },
      include: { _count: { select: { workItems: true } } },
    });

    // Teams notification (FR 8a162fe7): sprint lifecycle transitions.
    if (data.status !== undefined && data.status !== existing.status) {
      if (data.status === "ACTIVE") {
        void teamsNotify(
          orgId,
          "sprintStartEnd",
          `\u{1F3C1} Sprint <b>${escapeHtmlBasic(updated.name)}</b> started (${updated._count.workItems} item${updated._count.workItems === 1 ? "" : "s"})`,
        );
      } else if (data.status === "COMPLETED") {
        void teamsNotify(
          orgId,
          "sprintStartEnd",
          `\u2705 Sprint <b>${escapeHtmlBasic(updated.name)}</b> completed`,
        );
      }
    }

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
