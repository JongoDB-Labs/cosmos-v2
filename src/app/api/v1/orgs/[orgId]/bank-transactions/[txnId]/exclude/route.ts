import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { excludeTransaction } from "@/lib/bank/reconcile";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; txnId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, txnId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_MANAGE");

    const result = await excludeTransaction(orgId, txnId);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "bank_transaction.excluded",
      entity: "bank_transaction",
      entityId: txnId,
      ipAddress: getIpAddress(request),
    });
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
