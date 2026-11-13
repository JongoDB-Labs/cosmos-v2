import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { createTaxRate, listTaxRates } from "@/lib/tax/service";
import { taxRateSchema } from "@/lib/tax/validation";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_READ");

    const data = await listTaxRates(orgId);
    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_MANAGE");

    const input = taxRateSchema.parse(await request.json());
    const rate = await createTaxRate(orgId, ctx.userId, input);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "tax_rate.created",
      entity: "tax_rate",
      entityId: rate.id,
      ipAddress: getIpAddress(request),
    });
    return success(rate);
  } catch (error) {
    return handleApiError(error);
  }
}
