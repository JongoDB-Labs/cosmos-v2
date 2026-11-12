import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { roleCountsFor } from "@/lib/rbac/key-role";
import { approvalAuthority } from "@/lib/time/approval";
import { isManagerOf, hasManager } from "@/lib/time/timesheet-actions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { safeAutoPost, postExpenseToLedger } from "@/lib/ledger/auto-post";
import { visibleProjectRecordsWhere } from "@/lib/rbac/project-access";

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
    // An expense of a project the approver can't see is skipped, like a missing id.
    const visible = await visibleProjectRecordsWhere(ctx);

    // Bulk is not a way round the single-expense rule: each row is checked
    // with the same `approvalAuthority`, by whoever created it. One decision
    // per creator, since the answer depends only on who the subject is.
    const candidates = await prisma.expense.findMany({
      where: { id: { in: expenseIds }, orgId, status: "SUBMITTED", AND: [visible] },
      select: { id: true, createdById: true },
    });
    const mayApproveFor = new Map<string, { allowed: boolean; reason?: string }>();
    for (const subject of new Set(candidates.map((c) => c.createdById))) {
      mayApproveFor.set(
        subject,
        approvalAuthority({
          actorUserId: ctx.userId,
          subjectUserId: subject,
          hasTimeApprove: hasPermission(ctx.permissions, Permission.EXPENSE_APPROVE),
          isManagerOfSubject:
            roleCountsFor(ctx, Permission.EXPENSE_APPROVE) && (await isManagerOf(orgId, ctx.userId, subject)),
          subjectHasManager: await hasManager(orgId, subject),
          noun: "expense",
        }),
      );
    }
    const allowedIds: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const c of candidates) {
      const authority = mayApproveFor.get(c.createdById);
      if (authority?.allowed) allowedIds.push(c.id);
      else skipped.push({ id: c.id, reason: authority?.reason ?? "You cannot approve this expense" });
    }

    const result = allowedIds.length
      ? await prisma.expense.updateMany({
          // Still status-scoped: a racing approver may have decided one since.
          where: { id: { in: allowedIds }, orgId, status: "SUBMITTED" },
          data: {
            status: "APPROVED",
            approvedById: ctx.userId,
            approvedAt: new Date(),
          },
        })
      : { count: 0 };

    const approved = allowedIds.length
      ? await prisma.expense.findMany({
          where: { orgId, id: { in: allowedIds }, status: "APPROVED" },
          select: { id: true, orgId: true, amount: true, date: true, createdById: true, category: true },
        })
      : [];
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
      // missing, not SUBMITTED, or in a project the approver can't see).
      metadata: {
        count: String(result.count),
        requestedCount: String(expenseIds.length),
        // Refused by the approval rule (their own, while they have a supervisor).
        skippedCount: String(skipped.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ approvedCount: result.count, skipped });
  } catch (error) {
    return handleApiError(error);
  }
}
