import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RevenueType } from "@prisma/client";

const updateRevenueSchema = z.object({
  amount: z.number().positive().optional(),
  currency: z.string().max(10).nullish(),
  date: z.string().nullish(),
  client: z.string().nullish(),
  product: z.string().nullish(),
  type: z.nativeEnum(RevenueType).optional(),
  description: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string; revenueId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, revenueId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const revenue = await prisma.revenue.findFirst({
      where: { id: revenueId, orgId },
    });

    if (!revenue) return new Response("Not found", { status: 404 });

    return success(revenue);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, revenueId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Fail-fast bitfield gate BEFORE the record load: a non-FINANCE_MANAGE member
    // gets a uniform 403 with no 404-vs-403 existence oracle on money records.
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const existing = await prisma.revenue.findFirst({
      where: { id: revenueId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: FINANCE_MANAGE bitfield check + any narrowing deny
    // policy (by ownership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "FINANCE_MANAGE", { createdById: existing.createdById });

    const body = await request.json();
    const data = updateRevenueSchema.parse(body);

    const updated = await prisma.revenue.update({
      where: { id: revenueId },
      data: {
        ...(data.amount !== undefined && { amount: data.amount }),
        ...(data.currency !== undefined && { currency: data.currency ?? "USD" }),
        ...(data.date !== undefined && data.date !== null && { date: new Date(data.date) }),
        ...(data.client !== undefined && { client: data.client }),
        ...(data.product !== undefined && { product: data.product }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "revenue.updated",
      entity: "revenue",
      entityId: revenueId,
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
    const { orgId, revenueId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Fail-fast bitfield gate BEFORE the record load: a non-FINANCE_MANAGE member
    // gets a uniform 403 with no 404-vs-403 existence oracle on money records.
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const existing = await prisma.revenue.findFirst({
      where: { id: revenueId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: FINANCE_MANAGE bitfield check + any narrowing deny
    // policy (by ownership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "FINANCE_MANAGE", { createdById: existing.createdById });

    await prisma.revenue.delete({ where: { id: revenueId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "revenue.deleted",
      entity: "revenue",
      entityId: revenueId,
      metadata: { amount: String(existing.amount) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
