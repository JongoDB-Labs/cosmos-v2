import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; vendorId: string }>;
};

const partnerSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  socioEconomic: true,
  cageCode: true,
  perfRating: true,
} as const;

const updateSchema = z.object({
  partnerId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  value: z.number().nullish(),
  currency: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, vendorId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.contract.findFirst({
      where: { id: vendorId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const update: Prisma.ContractUncheckedUpdateInput = {};
    if (data.partnerId !== undefined) update.partnerId = data.partnerId;
    if (data.title !== undefined) update.title = data.title;
    if (data.value !== undefined) update.value = data.value ?? null;
    if (data.currency !== undefined) update.currency = data.currency;
    if (data.status !== undefined) update.status = data.status;
    if (data.startDate !== undefined) {
      update.startDate = data.startDate ? new Date(data.startDate) : null;
    }
    if (data.endDate !== undefined) {
      update.endDate = data.endDate ? new Date(data.endDate) : null;
    }

    const updated = await prisma.contract.update({
      where: { id: vendorId },
      data: update,
      include: { partner: { select: partnerSelect } },
    });

    return success({
      id: updated.id,
      partnerId: updated.partnerId,
      partner: updated.partner,
      title: updated.title,
      value: updated.value != null ? Number(updated.value) : null,
      currency: updated.currency,
      status: updated.status,
      startDate: updated.startDate ? updated.startDate.toISOString() : null,
      endDate: updated.endDate ? updated.endDate.toISOString() : null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, vendorId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.contract.findFirst({
      where: { id: vendorId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.contract.delete({ where: { id: vendorId } });
    return success({ id: vendorId });
  } catch (e) {
    return handleApiError(e);
  }
}
