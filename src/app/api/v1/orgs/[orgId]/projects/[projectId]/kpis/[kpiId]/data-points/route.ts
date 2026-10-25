import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createKpiDataPoint, listKpiDataPoints } from "./route.contract";
import { idempotent } from "@/lib/openapi/idempotency";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; kpiId: string }>;
};

async function loadKpi(orgId: string, projectId: string, kpiId: string) {
  return prisma.kpi.findFirst({ where: { id: kpiId, orgId, projectId } });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listKpiDataPoints);
    const { params: { orgId, projectId, kpiId } } = await parseRequest(listKpiDataPoints, request, params);
    // ANALYTICS_READ for a session. No key scope carries it (it reaches every
    // analytics and PM-register route), so a key reads KPIs with PROJECT_READ.
    await requireProjectRead(ctx, projectId, ctx.isApiKey ? "PROJECT_READ" : "ANALYTICS_READ");

    const kpi = await loadKpi(orgId, projectId, kpiId);
    if (!kpi) return problem(404, "not_found", undefined, { request });

    const dataPoints = await prisma.kpiDataPoint.findMany({
      where: { kpiId },
      orderBy: { recordedAt: "asc" },
    });

    return respond(listKpiDataPoints, 200, dataPoints);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createKpiDataPoint);
    const { params: { orgId, projectId, kpiId }, body: data } = await parseRequest(createKpiDataPoint, request, params);
    await requireProjectVisible(ctx, projectId);
    return await idempotent({ request, ctx, orgId, body: data }, async () => {
      await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

      const kpi = await loadKpi(orgId, projectId, kpiId);
      if (!kpi) return problem(404, "not_found", undefined, { request });

      const recordedAt = data.recordedAt ? new Date(data.recordedAt) : new Date();

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

      return respond(createKpiDataPoint, 200, dataPoint);
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
