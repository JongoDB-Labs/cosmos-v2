import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updatePartnerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  website: z.string().url().nullable().optional().or(z.literal("")),
  contactName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().email().nullable().optional().or(z.literal("")),
  contactPhone: z.string().max(50).nullable().optional(),
  notes: z.string().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; partnerId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, partnerId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const partner = await prisma.partner.findFirst({
      where: { id: partnerId, orgId },
      include: {
        contracts: {
          include: { product: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!partner) return new Response("Not found", { status: 404 });

    return success(partner);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, partnerId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_UPDATE);

    const existing = await prisma.partner.findFirst({
      where: { id: partnerId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updatePartnerSchema.parse(body);

    const updated = await prisma.partner.update({
      where: { id: partnerId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.type !== undefined && { type: data.type ?? "vendor" }),
        ...(data.status !== undefined && { status: data.status ?? "active" }),
        ...(data.website !== undefined && { website: data.website || null }),
        ...(data.contactName !== undefined && { contactName: data.contactName }),
        ...(data.contactEmail !== undefined && { contactEmail: data.contactEmail || null }),
        ...(data.contactPhone !== undefined && { contactPhone: data.contactPhone }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "partner.updated",
      entity: "partner",
      entityId: partnerId,
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
    const { orgId, partnerId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_DELETE);

    const existing = await prisma.partner.findFirst({
      where: { id: partnerId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.partner.delete({ where: { id: partnerId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "partner.deleted",
      entity: "partner",
      entityId: partnerId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
