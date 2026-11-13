import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { updateTaxRate, deleteTaxRate } from "@/lib/tax/service";
import { taxRateUpdateSchema } from "@/lib/tax/validation";
import { logAudit } from "@/lib/audit";
import { requireAccess } from "@/lib/abac/require-access";
import type { AuthContext } from "@/lib/rbac/check";

type RouteParams = { params: Promise<{ orgId: string; taxRateId: string }> };

async function gate(orgId: string): Promise<Response | AuthContext> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  await requireAccess(ctx, "FINANCE_MANAGE");
  return ctx;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, taxRateId } = await params;
    const ctx = await gate(orgId);
    if (ctx instanceof Response) return ctx;
    const input = taxRateUpdateSchema.parse(await request.json());
    const rate = await updateTaxRate(orgId, taxRateId, input);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "tax_rate.updated",
      entity: "tax_rate",
      entityId: taxRateId,
      metadata: { changed: Object.keys(input) },
      ipAddress: getIpAddress(request),
    });
    return success(rate);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, taxRateId } = await params;
    const ctx = await gate(orgId);
    if (ctx instanceof Response) return ctx;
    const result = await deleteTaxRate(orgId, taxRateId);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "tax_rate.deleted",
      entity: "tax_rate",
      entityId: taxRateId,
      ipAddress: getIpAddress(request),
    });
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
