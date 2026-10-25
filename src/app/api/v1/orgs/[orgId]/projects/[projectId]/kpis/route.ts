import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { computeExecutionMetrics, applyKpiAutoValue } from "@/lib/pm/kpi-derive";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createKpi, listKpis } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listKpis);
    const { params: { orgId, projectId } } = await parseRequest(listKpis, request, params);
    // ANALYTICS_READ for a session. No key scope carries it (it reaches every
    // analytics and PM-register route), so a key reads KPIs with PROJECT_READ.
    await requireProjectRead(ctx, projectId, ctx.isApiKey ? "PROJECT_READ" : "ANALYTICS_READ");

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

    const kpis = await prisma.kpi.findMany({
      where: { orgId, projectId },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });

    // Auto-source KPIs derive currentValue from execution (computed on read).
    if (!kpis.some((k) => k.autoSource !== "MANUAL")) {
      return respond(listKpis, 200, kpis.map((k) => ({ ...k, derived: false })));
    }
    const metrics = await computeExecutionMetrics(orgId, projectId, new Date());
    const withDerived = kpis.map((k) => {
      const v = applyKpiAutoValue(k.autoSource, k.autoWindowDays, metrics);
      return v === null ? { ...k, derived: false } : { ...k, currentValue: v, derived: true };
    });
    return respond(listKpis, 200, withDerived);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createKpi);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createKpi, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

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
        autoSource: data.autoSource,
        autoWindowDays: data.autoWindowDays ?? null,
        sortOrder,
      },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
    });

    return respond(createKpi, 200, created);
  } catch (e) {
    return handleApiError(e, request);
  }
}
