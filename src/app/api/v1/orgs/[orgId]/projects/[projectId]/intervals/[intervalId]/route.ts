import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { updateWorkItems } from "@/lib/work-items/write.server";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { channelPolicy } from "@/lib/integrations/channel-policy.server";
import { writeIntervalChange } from "@/lib/intervals/pi-lifecycle.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { getInterval, updateInterval } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; intervalId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getInterval);
    const { params: { orgId, projectId, intervalId } } = await parseRequest(getInterval, request, params);
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, projectId, orgId },
      include: {
        workItems: {
          // The org's own items only: an older, unchecked write may have left
          // another org's item pointing at this sprint.
          where: { orgId },
          // Full-text index internals: never part of the WorkItem contract, so
          // not fetched (respond() would otherwise reject the row outside prod).
          omit: { searchVector: true },
          include: {
            _count: { select: { comments: true } },
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        },
        _count: { select: { workItems: { where: { orgId } } } },
      },
    });

    if (!interval) return problem(404, "not_found", undefined, { request });

    return respond(getInterval, 200, interval);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateInterval);
    const { params: { orgId, projectId, intervalId }, body: data } = await parseRequest(updateInterval, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.SPRINT_UPDATE);

    const existing = await prisma.interval.findFirst({ where: { id: intervalId, projectId, orgId } });
    if (!existing) return problem(404, "not_found", undefined, { request });

    // The Program Increment rules (nesting, a PI is never started by hand, one
    // running sprint, a PI completes after its sprints) and the PI a started
    // sprint starts: one function, which Cosmo's update_interval calls too.
    const updated = await writeIntervalChange(existing, data, () =>
      prisma.interval.update({
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
      }),
    );

    // Teams notification (FR 8a162fe7): sprint lifecycle transitions.
    // The channel is read org-wide: nothing from a team-scoped or marked
    // project, and a marked sprint name is left out.
    if (data.status !== undefined && data.status !== existing.status && (data.status === "ACTIVE" || data.status === "COMPLETED")) {
      const status = data.status;
      void (async () => {
        const policy = await channelPolicy(orgId);
        const project = await policy.project(projectId);
        if (!project) return;
        const name = policy.text(projectId, updated.name);
        const sprint = name ? `Sprint <b>${escapeHtmlBasic(name)}</b>` : `A sprint in <b>${project.key}</b>`;
        const count = updated._count.workItems;
        await teamsNotify(
          orgId,
          "sprintStartEnd",
          status === "ACTIVE"
            ? `\u{1F3C1} ${sprint} started (${count} item${count === 1 ? "" : "s"})`
            : `\u2705 ${sprint} completed`,
          { projectIds: [projectId] },
        );
      })().catch(() => {});
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

    return respond(updateInterval, 200, updated);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", undefined, { request });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.SPRINT_UPDATE);

    const existing = await prisma.interval.findFirst({ where: { id: intervalId, projectId, orgId } });
    if (!existing) return problem(404, "not_found", undefined, { request });

    if (existing.status === "ACTIVE") {
      return problem(409, "conflict", "Cannot delete an active interval. Complete it first.", { request });
    }

    await prisma.$transaction(async (tx) => {
      const members = await tx.workItem.findMany({ where: { intervalId }, select: { id: true } });
      await updateWorkItems(tx, members.map((m) => m.id), { intervalId: null }, { actorId: ctx.userId, source: "API" });
      await tx.interval.delete({ where: { id: intervalId } });
    });

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
    return handleApiError(error, request);
  }
}
