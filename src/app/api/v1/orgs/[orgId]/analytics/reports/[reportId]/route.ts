import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const updateReportSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  type: z.string().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  schedule: z.string().max(200).nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; reportId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, reportId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.REPORT_CREATE);

    const report = await prisma.savedReport.findFirst({
      where: { id: reportId, orgId },
    });

    if (!report) return new Response("Not found", { status: 404 });

    return success(report);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, reportId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.savedReport.findFirst({
      where: { id: reportId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: REPORT_MANAGE in the bitfield AND any deny policy
    // referencing it (e.g. owns_resource narrowing). Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "REPORT_MANAGE", {
      createdById: existing.createdById,
    });

    const body = await request.json();
    const data = updateReportSchema.parse(body);

    const updated = await prisma.savedReport.update({
      where: { id: reportId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.config !== undefined && {
          config: data.config as Prisma.InputJsonValue,
        }),
        ...(data.schedule !== undefined && { schedule: data.schedule }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "report.updated",
      entity: "savedReport",
      entityId: reportId,
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
    const { orgId, reportId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.savedReport.findFirst({
      where: { id: reportId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: REPORT_MANAGE in the bitfield AND any deny policy
    // referencing it (e.g. owns_resource narrowing). Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "REPORT_MANAGE", {
      createdById: existing.createdById,
    });

    await prisma.savedReport.delete({ where: { id: reportId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "report.deleted",
      entity: "savedReport",
      entityId: reportId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
