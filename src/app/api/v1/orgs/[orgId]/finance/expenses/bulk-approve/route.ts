import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { safeAutoPost, postExpenseToLedger } from "@/lib/ledger/auto-post";

const bulkSchema = z.object({
  expenseIds: z.array(z.string().uuid()).min(1).max(500),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.EXPENSE_APPROVE);

    const { expenseIds } = bulkSchema.parse(await request.json());

    const result = await prisma.expense.updateMany({
      where: { id: { in: expenseIds }, orgId, status: "SUBMITTED" },
      data: {
        status: "APPROVED",
        approvedById: ctx.userId,
        approvedAt: new Date(),
      },
    });

    const approved = await prisma.expense.findMany({
      where: { orgId, id: { in: expenseIds }, status: "APPROVED" },
      select: { id: true, orgId: true, amount: true, date: true, createdById: true, category: true },
    });
    for (const exp of approved) {
      await safeAutoPost(() => postExpenseToLedger(exp), `expense ${exp.id}`);
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.bulk_approved",
      entity: "expense",
      entityId: expenseIds.join(","),
      // requestedCount vs count reveals ids skipped by the WHERE (cross-org,
      // missing, or not SUBMITTED).
      metadata: {
        count: String(result.count),
        requestedCount: String(expenseIds.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ approvedCount: result.count });
  } catch (error) {
    return handleApiError(error);
  }
}
