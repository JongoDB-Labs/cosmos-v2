import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ControlStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const updateControlSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  status: z.nativeEnum(ControlStatus).optional(),
  evidence: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).optional(),
  notes: z.string().nullish(),
  dueDate: z.string().datetime().nullable().optional(),
  assessedAt: z.string().datetime().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; controlDbId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, controlDbId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_READ);

    const control = await prisma.complianceControl.findFirst({
      where: { id: controlDbId, orgId },
    });

    if (!control) return new Response("Not found", { status: 404 });

    return success(control);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, controlDbId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_MANAGE);

    const existing = await prisma.complianceControl.findFirst({
      where: { id: controlDbId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateControlSchema.parse(body);

    const statusChanged = data.status !== undefined && data.status !== existing.status;

    const updated = await prisma.complianceControl.update({
      where: { id: controlDbId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.evidence !== undefined && { evidence: data.evidence as Prisma.InputJsonValue }),
        ...(data.notes !== undefined && { notes: data.notes ?? "" }),
        ...(data.dueDate !== undefined && {
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
        }),
        ...(data.assessedAt !== undefined && {
          assessedAt: data.assessedAt ? new Date(data.assessedAt) : null,
        }),
        ...(statusChanged && { assessedById: ctx.userId }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "compliance_control.updated",
      entity: "compliance_control",
      entityId: controlDbId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, controlDbId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_MANAGE);

    const existing = await prisma.complianceControl.findFirst({
      where: { id: controlDbId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateControlSchema.partial().parse(body);

    const statusChanged = data.status !== undefined && data.status !== existing.status;

    const updated = await prisma.complianceControl.update({
      where: { id: controlDbId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.evidence !== undefined && { evidence: data.evidence as Prisma.InputJsonValue }),
        ...(data.notes !== undefined && { notes: data.notes ?? "" }),
        ...(data.dueDate !== undefined && {
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
        }),
        ...(data.assessedAt !== undefined && {
          assessedAt: data.assessedAt ? new Date(data.assessedAt) : null,
        }),
        ...(statusChanged && { assessedById: ctx.userId }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "compliance_control.patched",
      entity: "compliance_control",
      entityId: controlDbId,
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
    const { orgId, controlDbId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_MANAGE);

    const existing = await prisma.complianceControl.findFirst({
      where: { id: controlDbId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.complianceControl.delete({ where: { id: controlDbId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "compliance_control.deleted",
      entity: "compliance_control",
      entityId: controlDbId,
      metadata: { controlId: existing.controlId, framework: existing.framework } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
