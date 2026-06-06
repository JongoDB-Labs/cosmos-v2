import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { safeAutoPost, postExpenseToLedger } from "@/lib/ledger/auto-post";

const approveSchema = z.object({ action: z.enum(["approve", "reject"]) });

type RouteParams = { params: Promise<{ orgId: string; expenseId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.EXPENSE_APPROVE);

    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    if (existing.status !== "SUBMITTED") {
      return new Response(
        JSON.stringify({ error: "Only submitted expenses can be approved or rejected" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = approveSchema.parse(await request.json());

    // Status-scoped write so two racing approvers can't both pass the in-memory
    // SUBMITTED check and double-stamp. Only the approve path records an
    // approver — a rejection isn't an approval, so it leaves those fields null.
    const result = await prisma.expense.updateMany({
      where: { id: expenseId, orgId, status: "SUBMITTED" },
      data:
        data.action === "approve"
          ? { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date() }
          : { status: "REJECTED", approvedById: null, approvedAt: null },
    });
    if (result.count === 0) {
      return new Response(
        JSON.stringify({ error: "Only submitted expenses can be approved or rejected" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    const updated = await prisma.expense.findFirstOrThrow({
      where: { id: expenseId, orgId },
    });

    if (data.action === "approve") {
      await safeAutoPost(() => postExpenseToLedger(updated), `expense ${updated.id}`);
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: `expense.${data.action}d`,
      entity: "expense",
      entityId: expenseId,
      metadata: { action: data.action, previousStatus: existing.status } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
