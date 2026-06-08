import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { reconciliationSummary } from "@/lib/bank/reconciliation";

type RouteParams = { params: Promise<{ orgId: string; bankAccountId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, bankAccountId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const account = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, orgId },
    });
    if (!account) return new Response("Not found", { status: 404 });

    return success({ data: await reconciliationSummary(orgId, bankAccountId) });
  } catch (error) {
    return handleApiError(error);
  }
}
