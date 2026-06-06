import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateProductSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().max(10).nullish(),
  status: z.string().nullish(),
  category: z.string().max(100).nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; productId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, productId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const product = await prisma.product.findFirst({
      where: { id: productId, orgId },
      include: {
        contracts: {
          include: { partner: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!product) return new Response("Not found", { status: 404 });

    return success(product);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, productId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_UPDATE);

    const existing = await prisma.product.findFirst({
      where: { id: productId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateProductSchema.parse(body);

    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.sku !== undefined && { sku: data.sku }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.currency !== undefined && { currency: data.currency ?? "USD" }),
        ...(data.status !== undefined && { status: data.status ?? "active" }),
        ...(data.category !== undefined && { category: data.category }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "product.updated",
      entity: "product",
      entityId: productId,
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
    const { orgId, productId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_DELETE);

    const existing = await prisma.product.findFirst({
      where: { id: productId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.product.delete({ where: { id: productId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "product.deleted",
      entity: "product",
      entityId: productId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
