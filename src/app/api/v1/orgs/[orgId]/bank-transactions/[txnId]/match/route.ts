import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { matchTransaction } from "@/lib/bank/reconcile";

const schema = z.object({
  targetType: z.enum(["expense", "revenue"]),
  targetId: z.string().min(1),
});

type RouteParams = { params: Promise<{ orgId: string; txnId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, txnId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const body = await request.json();
    const { targetType, targetId } = schema.parse(body);

    return success(await matchTransaction(orgId, txnId, targetType, targetId));
  } catch (error) {
    return handleApiError(error);
  }
}
