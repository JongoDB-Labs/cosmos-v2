import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { voidInvoice } from "@/lib/invoicing/service";

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    return success(await voidInvoice(orgId, invoiceId, ctx.userId));
  } catch (error) {
    return handleApiError(error);
  }
}
