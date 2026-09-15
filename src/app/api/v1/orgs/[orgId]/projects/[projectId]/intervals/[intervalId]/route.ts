import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { SprintStatus } from "@prisma/client";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import {
  activationBlocker,
  isProgramIncrement,
  programIncrementBlockers,
  userMaySetStatus,
} from "@/lib/intervals/pi-lifecycle";

const updateIntervalSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().nullish(),
  startDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
  status: z.nativeEnum(SprintStatus).optional(),
  // Program Increment to nest this sprint under (a PI interval id), or null to
  // detach it back to top level. Validated same-project + must be a PI.
  parentId: z.string().uuid().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; intervalId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, projectId, orgId },
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

    if (!interval) return new Response("Not found", { status: 404 });

    return success(interval);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectManage(ctx, projectId, Permission.SPRINT_UPDATE);

    const existing = await prisma.interval.findFirst({ where: { id: intervalId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateIntervalSchema.parse(body);

    // Validate a PI re-parent: target must be a PROGRAM_INCREMENT in this
    // project, and an interval can't be its own parent (no 1-level self-nesting).
    if (data.parentId !== undefined && data.parentId !== null) {
      if (data.parentId === intervalId) {
        return new Response(JSON.stringify({ error: "An interval can't be its own Program Increment" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const parent = await prisma.interval.findFirst({
        where: { id: data.parentId, projectId },
        select: { intervalKind: true },
      });
      if (!parent || parent.intervalKind !== "PROGRAM_INCREMENT") {
        return new Response(
          JSON.stringify({ error: "A sprint can only be nested under a Program Increment" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // A Program Increment is a container: it spans its sprints rather than
    // competing with them, so it is never started by hand.
    if (
      data.status !== undefined &&
      !userMaySetStatus(existing.intervalKind, data.status)
    ) {
      return new Response(
        JSON.stringify({
          error:
            "A Program Increment starts when its first sprint starts — it is not started directly.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (data.status === "ACTIVE") {
      const others = await prisma.interval.findMany({
        where: { projectId },
        select: { id: true, name: true, intervalKind: true, status: true },
      });
      // Excludes Program Increments. Counting the parent PI as a competitor is
      // what made a sprint unable to start until its own PI had finished — which
      // could never happen, since a PI finishes when its sprints do.
      const blocker = activationBlocker({ id: intervalId }, others);
      if (blocker) {
        return new Response(
          JSON.stringify({
            error: `${blocker.name} is still active — complete it first.`,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // A PI is done only once everything inside it is. Named, so the refusal
    // tells the user what to finish.
    if (data.status === "COMPLETED" && isProgramIncrement(existing.intervalKind)) {
      const children = await prisma.interval.findMany({
        where: { parentId: intervalId },
        select: { id: true, name: true, intervalKind: true, status: true },
      });
      const open = programIncrementBlockers(children);
      if (open.length > 0) {
        return new Response(
          JSON.stringify({
            error: `This Program Increment still has unfinished iterations: ${open
              .map((i) => i.name)
              .join(", ")}.`,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const updated = await prisma.interval.update({
      where: { id: intervalId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.goal !== undefined && { goal: data.goal ?? "" }),
        ...(data.startDate !== undefined && data.startDate !== null && { startDate: new Date(data.startDate) }),
        ...(data.endDate !== undefined && data.endDate !== null && { endDate: new Date(data.endDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
      },
      include: { _count: { select: { workItems: true } } },
    });

    // Starting a sprint starts the increment that contains it. The PI has no
    // start control of its own, so without this it would sit PLANNED while its
    // sprints ran — and its own completion gate would read as already satisfied.
    if (data.status === "ACTIVE" && existing.parentId) {
      await prisma.interval.updateMany({
        where: {
          id: existing.parentId,
          intervalKind: "PROGRAM_INCREMENT",
          status: "PLANNED",
        },
        data: { status: "ACTIVE" },
      });
    }

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
      action: "interval.updated",
      entity: "interval",
      entityId: intervalId,
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
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectManage(ctx, projectId, Permission.SPRINT_UPDATE);

    const existing = await prisma.interval.findFirst({ where: { id: intervalId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    if (existing.status === "ACTIVE") {
      return new Response(
        JSON.stringify({ error: "Cannot delete an active interval. Complete it first." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.$transaction([
      prisma.workItem.updateMany({
        where: { intervalId },
        data: { intervalId: null },
      }),
      prisma.interval.delete({ where: { id: intervalId } }),
    ]);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "interval.deleted",
      entity: "interval",
      entityId: intervalId,
      metadata: { name: existing.name, number: String(existing.number) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
