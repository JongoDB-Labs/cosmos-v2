import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { partnerSelect, mapVendorContract } from "@/lib/pm/vendor";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; vendorId: string }>;
};

const updateSchema = z.object({
  partnerId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  value: z.number().nullish(),
  fundedValue: z.number().nullish(),
  invoicedValue: z.number().nullish(),
  paymentTerms: z.string().max(120).nullish(),
  agmtType: z.string().max(40).nullish(),
  agmtNumber: z.string().max(80).nullish(),
  currency: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  // Partner-level fields (the sub/vendor entity behind this contract)
  ndaOnFile: z.boolean().optional(),
  ndaExpiry: z.string().nullish(),
  pocName: z.string().max(120).nullish(),
  pocEmail: z.string().max(160).nullish(),
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

    // Partner-level NDA / POC fields update the linked Partner first, so the
    // contract re-read below reflects them.
    const partnerUpdate: Prisma.PartnerUncheckedUpdateInput = {};
    if (data.ndaOnFile !== undefined) partnerUpdate.ndaOnFile = data.ndaOnFile;
    if (data.ndaExpiry !== undefined) {
      partnerUpdate.ndaExpiry = data.ndaExpiry ? new Date(data.ndaExpiry) : null;
    }
    if (data.pocName !== undefined) partnerUpdate.pocName = data.pocName ?? null;
    if (data.pocEmail !== undefined) partnerUpdate.pocEmail = data.pocEmail ?? null;
    const targetPartnerId = data.partnerId ?? existing.partnerId;
    if (Object.keys(partnerUpdate).length > 0 && targetPartnerId) {
      await prisma.partner.update({ where: { id: targetPartnerId }, data: partnerUpdate });
    }

    const update: Prisma.ContractUncheckedUpdateInput = {};
    if (data.partnerId !== undefined) update.partnerId = data.partnerId;
    if (data.title !== undefined) update.title = data.title;
    if (data.value !== undefined) update.value = data.value ?? null;
    if (data.fundedValue !== undefined) update.fundedValue = data.fundedValue ?? null;
    if (data.invoicedValue !== undefined) update.invoicedValue = data.invoicedValue ?? null;
    if (data.paymentTerms !== undefined) update.paymentTerms = data.paymentTerms ?? null;
    if (data.agmtType !== undefined) update.agmtType = data.agmtType ?? null;
    if (data.agmtNumber !== undefined) update.agmtNumber = data.agmtNumber ?? null;
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

    return success(mapVendorContract(updated));
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
