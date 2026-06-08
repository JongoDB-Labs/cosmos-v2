import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { updateTaxRate, deleteTaxRate } from "@/lib/tax/service";
import { taxRateUpdateSchema } from "@/lib/tax/validation";

type RouteParams = { params: Promise<{ orgId: string; taxRateId: string }> };

async function gate(orgId: string): Promise<Response | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  requirePermission(ctx, Permission.FINANCE_MANAGE);
  return null;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, taxRateId } = await params;
    const denied = await gate(orgId);
    if (denied) return denied;
    const input = taxRateUpdateSchema.parse(await request.json());
    return success(await updateTaxRate(orgId, taxRateId, input));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, taxRateId } = await params;
    const denied = await gate(orgId);
    if (denied) return denied;
    return success(await deleteTaxRate(orgId, taxRateId));
  } catch (error) {
    return handleApiError(error);
  }
}
