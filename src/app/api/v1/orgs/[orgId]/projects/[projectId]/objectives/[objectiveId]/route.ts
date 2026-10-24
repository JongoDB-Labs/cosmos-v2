import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteObjective, getObjective, updateObjective } from "./route.contract";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

async function loadObjective(orgId: string, projectId: string, objectiveId: string) {
  return prisma.objective.findFirst({
    where: { id: objectiveId, orgId, projectId },
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getObjective);
    const { params: { orgId, projectId, objectiveId } } = await parseRequest(getObjective, request, params);
    await requireProjectRead(ctx, projectId, "OKR_READ");

    const objective = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });
    if (!objective) return problem(404, "not_found", undefined, { request });

    return respond(getObjective, 200, objective);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateObjective);
    const { params: { orgId, projectId, objectiveId }, body: data } = await parseRequest(updateObjective, request, params);
    await requireProjectVisible(ctx, projectId);

    const existing = await loadObjective(orgId, projectId, objectiveId);
    if (!existing) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz: OKR_UPDATE in the bitfield AND any narrowing deny
    // policy (by ownership / project membership). Identical to requirePermission
    // until a policy references OKR_UPDATE.
    await requireAccess(ctx, "OKR_UPDATE", {
      ownerId: existing.ownerId,
      projectId,
    });

    // Alignment validation: a same-project parent, never itself, never a
    // descendant (which would make a cycle and break the tree/rollup).
    if (data.parentId) {
      if (data.parentId === objectiveId) {
        return problem(400, "invalid_request", "An objective can't align to itself", { request });
      }
      const parent = await prisma.objective.findFirst({
        where: { id: data.parentId, orgId, projectId },
        select: { parentId: true },
      });
      if (!parent) return problem(400, "invalid_request", "Parent objective not found", { request });
      let cur = parent.parentId;
      for (let guard = 0; cur && guard < 100; guard++) {
        if (cur === objectiveId) {
          return problem(400, "invalid_request", "That alignment would create an interval", { request });
        }
        const next = await prisma.objective.findUnique({
          where: { id: cur },
          select: { parentId: true },
        });
        cur = next?.parentId ?? null;
      }
    }

    // Same rule as create: an interval belonging to another project would
    // mis-file the objective under a timebox its team never plans against.
    if (data.intervalId) {
      const interval = await prisma.interval.findFirst({
        where: { id: data.intervalId, projectId },
        select: { id: true },
      });
      if (!interval) {
        return new Response("intervalId must be an interval of this project", {
          status: 400,
        });
      }
    }

    const updated = await prisma.objective.update({
      where: { id: objectiveId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.period !== undefined && { period: data.period }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
        ...(data.targetDate !== undefined && {
          targetDate: data.targetDate ? new Date(data.targetDate) : null,
        }),
        ...(data.intervalId !== undefined && { intervalId: data.intervalId }),
        ...(data.committed !== undefined && { committed: data.committed }),
      },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });

    return respond(updateObjective, 200, updated);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteObjective);
    const { params: { orgId, projectId, objectiveId } } = await parseRequest(deleteObjective, request, params);
    await requireProjectVisible(ctx, projectId);

    const existing = await loadObjective(orgId, projectId, objectiveId);
    if (!existing) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz (OKR_DELETE + any narrowing deny policy).
    await requireAccess(ctx, "OKR_DELETE", {
      ownerId: existing.ownerId,
      projectId,
    });

    // Key results cascade-delete via the FK.
    await prisma.objective.delete({ where: { id: objectiveId } });

    return respond(deleteObjective, 200, { id: objectiveId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
