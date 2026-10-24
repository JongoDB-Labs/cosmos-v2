import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { IntervalKind } from "@prisma/client";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createInterval, listIntervals } from "./route.contract";
import { idempotent } from "@/lib/openapi/idempotency";

/** Validate a parentId points at a PROGRAM_INCREMENT interval in the same project.
 *  Returns an error message, or null when it's a valid PI (or no parent). */
async function validateParentPI(
  parentId: string | null | undefined,
  projectId: string,
): Promise<string | null> {
  if (!parentId) return null;
  const parent = await prisma.interval.findFirst({
    where: { id: parentId, projectId },
    select: { intervalKind: true },
  });
  if (!parent) return "Program Increment not found in this project";
  if (parent.intervalKind !== IntervalKind.PROGRAM_INCREMENT) {
    return "A sprint can only be nested under a Program Increment";
  }
  return null;
}

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listIntervals);
    const { params: { orgId, projectId }, query } = await parseRequest(listIntervals, request, params);
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    const intervals = await prisma.interval.findMany({
      where: {
        orgId,
        projectId,
        ...(query.status && { status: query.status }),
      },
      include: {
        _count: { select: { workItems: true } },
      },
      orderBy: { number: "desc" },
    });

    return respond(listIntervals, 200, intervals);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createInterval);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createInterval, request, params);
    await requireProjectVisible(ctx, projectId);
    return await idempotent({ request, ctx, orgId, body: data }, async () => {
      await requireProjectManage(ctx, projectId, Permission.SPRINT_CREATE);

      const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
      if (!project) return problem(404, "not_found", undefined, { request });

      // A PI is top-level; a sprint may nest under a PI (validated same-project).
      const parentId =
        data.intervalKind === IntervalKind.PROGRAM_INCREMENT ? null : (data.parentId ?? null);
      const parentErr = await validateParentPI(parentId, projectId);
      if (parentErr) {
        return problem(400, "invalid_request", parentErr, { request });
      }

      const maxNumber = await prisma.interval.aggregate({
        where: { projectId },
        _max: { number: true },
      });
      const number = (maxNumber._max.number ?? 0) + 1;

      const interval = await prisma.interval.create({
        data: {
          orgId,
          projectId,
          number,
          name: data.name,
          goal: data.goal ?? "",
          startDate: new Date(data.startDate),
          endDate: new Date(data.endDate),
          intervalKind: data.intervalKind,
          parentId,
        },
        include: {
          _count: { select: { workItems: true } },
        },
      });

      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "interval.created",
        entity: "interval",
        entityId: interval.id,
        metadata: { name: data.name, number: String(number) } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });

      return respond(createInterval, 201, interval);
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}
