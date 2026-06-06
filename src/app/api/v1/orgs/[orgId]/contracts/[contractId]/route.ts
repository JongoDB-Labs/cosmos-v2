import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateContractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  partnerId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  value: z.number().nullable().optional(),
  currency: z.string().max(10).nullish(),
  status: z.string().nullish(),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  terms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; contractId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contractId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId },
      include: {
        partner: true,
        product: true,
      },
    });

    if (!contract) return new Response("Not found", { status: 404 });

    return success(contract);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contractId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_UPDATE);

    const existing = await prisma.contract.findFirst({
      where: { id: contractId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateContractSchema.parse(body);

    const updated = await prisma.contract.update({
      where: { id: contractId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.partnerId !== undefined && { partnerId: data.partnerId }),
        ...(data.productId !== undefined && { productId: data.productId }),
        ...(data.value !== undefined && { value: data.value }),
        ...(data.currency !== undefined && { currency: data.currency ?? "USD" }),
        ...(data.status !== undefined && { status: data.status ?? "draft" }),
        ...(data.startDate !== undefined && {
          startDate: data.startDate ? new Date(data.startDate) : null,
        }),
        ...(data.endDate !== undefined && {
          endDate: data.endDate ? new Date(data.endDate) : null,
        }),
        ...(data.terms !== undefined && { terms: data.terms }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
      include: {
        partner: true,
        product: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "contract.updated",
      entity: "contract",
      entityId: contractId,
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
    const { orgId, contractId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_DELETE);

    const existing = await prisma.contract.findFirst({
      where: { id: contractId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.contract.delete({ where: { id: contractId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "contract.deleted",
      entity: "contract",
      entityId: contractId,
      metadata: { title: existing.title } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
