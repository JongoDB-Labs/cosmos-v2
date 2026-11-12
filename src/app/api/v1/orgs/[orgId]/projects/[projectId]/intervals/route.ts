import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import type { IntervalKind } from "@prisma/client";
import { nestingRefusal } from "@/lib/intervals/pi-lifecycle";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createInterval, listIntervals } from "./route.contract";

/** Why a new interval of `kind` can't sit inside `parentId`, or null when it
 *  can (or has no parent). The parent must be a Program Increment in this
 *  project, and a Program Increment itself is always top-level. */
async function validateParent(
  kind: IntervalKind,
  parentId: string | null | undefined,
  projectId: string,
): Promise<string | null> {
  if (!parentId) return null;
  const parent = await prisma.interval.findFirst({
    where: { id: parentId, projectId },
    select: { intervalKind: true },
  });
  return nestingRefusal(kind, parent);
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
    await requireProjectManage(ctx, projectId, Permission.SPRINT_CREATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    // A sprint may nest under a PI in this project. A PI is top-level: one sent
    // with a parent is refused rather than quietly created at the top, so the
    // caller learns the rule instead of finding the PI somewhere it didn't ask.
    const parentId = data.parentId ?? null;
    const parentErr = await validateParent(data.intervalKind, parentId, projectId);
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
  } catch (error) {
    return handleApiError(error, request);
  }
}
