import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const createReportSchema = z.object({
  name: z.string().min(1).max(500),
  type: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  schedule: z.string().max(200).nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Reading saved reports is a read op — gate on ANALYTICS_READ (like the
    // sprints/portfolio/intervals GETs). REPORT_CREATE stays on save/delete, so a
    // read-only analyst (ANALYTICS_READ without REPORT_CREATE) can view reports.
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const type = request.nextUrl.searchParams.get("type");

    const reports = await prisma.savedReport.findMany({
      where: {
        orgId,
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return success(reports);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.REPORT_CREATE);

    const body = await request.json();
    const data = createReportSchema.parse(body);

    const report = await prisma.savedReport.create({
      data: {
        orgId,
        createdById: ctx.userId,
        name: data.name,
        type: data.type,
        config: data.config as Prisma.InputJsonValue,
        schedule: data.schedule ?? null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "report.created",
      entity: "savedReport",
      entityId: report.id,
      metadata: { name: data.name, type: data.type } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(report);
  } catch (error) {
    return handleApiError(error);
  }
}
