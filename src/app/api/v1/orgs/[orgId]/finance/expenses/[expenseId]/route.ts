import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { inVisibleProject, requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import { assertRefsInScope } from "@/lib/rbac/foreign-refs";
import { reimbursableNeedsProject } from "@/lib/finance/reimbursable";
import { roleCountsFor } from "@/lib/rbac/key-role";
import { approvalAuthority } from "@/lib/time/approval";
import { isManagerOf, hasManager } from "@/lib/time/timesheet-actions";

const updateExpenseSchema = z.object({
  amount: z.number().positive().optional(),
  currency: z.string().max(10).nullish(),
  date: z.string().nullish(),
  category: z.string().min(1).optional(),
  vendor: z.string().nullish(),
  description: z.string().nullish(),
  recurring: z.boolean().optional(),
  clinId: z.string().uuid().nullish(),
  // The form has always sent the project; it was dropped here until now.
  projectId: z.string().uuid().nullish(),
  reimbursable: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; expenseId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const expense = await prisma.expense.findFirst({
      where: { id: expenseId, orgId },
    });

    if (!expense || !(await inVisibleProject(ctx, expense.projectId))) return new Response("Not found", { status: 404 });

    return success(expense);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Fail-fast bitfield gate BEFORE the record load: a non-FINANCE_MANAGE member
    // gets a uniform 403 with no 404-vs-403 existence oracle on money records.
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId },
    });
    if (!existing || !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });

    // Resource-aware authz: checks FINANCE_MANAGE in the bitfield AND applies any
    // work-role/member deny policy that references it (narrowing by ownership).
    // Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "FINANCE_MANAGE", { createdById: existing.createdById });

    // Once submitted/approved, an expense is locked from edits to protect the
    // approval gate. EXPENSE_APPROVE holders (approvers/admins) may still amend
    // for corrections/voiding and to manage historical (grandfathered) rows.
    if (
      existing.status !== "DRAFT" &&
      existing.status !== "REJECTED" &&
      !hasPermission(ctx.permissions, Permission.EXPENSE_APPROVE)
    ) {
      return new Response(
        JSON.stringify({ error: "Only draft or rejected expenses can be edited" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    // An approver's licence to amend a locked expense is an APPROVAL power, so
    // it follows the approval rule: not over their own expense while they have
    // a supervisor. Otherwise "have it approved at 50, then make it 5,000" is
    // self-approval by the back door.
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      const authority = approvalAuthority({
        actorUserId: ctx.userId,
        subjectUserId: existing.createdById,
        hasTimeApprove: hasPermission(ctx.permissions, Permission.EXPENSE_APPROVE),
        isManagerOfSubject:
          roleCountsFor(ctx, Permission.EXPENSE_APPROVE) && (await isManagerOf(orgId, ctx.userId, existing.createdById)),
        subjectHasManager: await hasManager(orgId, existing.createdById),
        noun: "expense",
      });
      if (!authority.allowed) {
        return new Response(
          JSON.stringify({ error: "Your own submitted or approved expense can only be changed by your supervisor or another approver" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const body = await request.json();
    const data = updateExpenseSchema.parse(body);
    // Moving it to a project is writing to that project.
    await requireProjectVisibleIf(ctx, data.projectId);
    const nextProject = data.projectId !== undefined ? data.projectId : existing.projectId;
    // The CLIN it ends up charged to must be this org's, and on the project it
    // ends up under (lib/rbac/foreign-refs.ts). Moving the expense re-checks the
    // CLIN it keeps; otherwise the check is of the CLIN the body names.
    const projectChanged = data.projectId !== undefined && data.projectId !== existing.projectId;
    const clinToCheck = projectChanged && data.clinId === undefined ? existing.clinId : data.clinId;
    await assertRefsInScope({ orgId, projectId: nextProject, viewer: ctx }, { clin: clinToCheck });
    const nextReimbursable = data.reimbursable ?? existing.reimbursable;
    if (nextReimbursable && !nextProject) return reimbursableNeedsProject();

    const updated = await prisma.expense.update({
      where: { id: expenseId },
      data: {
        ...(data.amount !== undefined && { amount: data.amount }),
        ...(data.currency !== undefined && { currency: data.currency ?? "USD" }),
        ...(data.date !== undefined && data.date !== null && { date: new Date(data.date) }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.vendor !== undefined && { vendor: data.vendor }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.recurring !== undefined && { recurring: data.recurring }),
        ...(data.clinId !== undefined && { clinId: data.clinId }),
        ...(data.projectId !== undefined && { projectId: data.projectId }),
        ...(data.reimbursable !== undefined && { reimbursable: data.reimbursable }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.updated",
      entity: "expense",
      entityId: expenseId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Fail-fast bitfield gate BEFORE the record load: a non-FINANCE_MANAGE member
    // gets a uniform 403 with no 404-vs-403 existence oracle on money records.
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, orgId },
    });
    if (!existing || !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });

    // Resource-aware authz: FINANCE_MANAGE bitfield check + any narrowing deny
    // policy (by ownership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "FINANCE_MANAGE", { createdById: existing.createdById });

    // Mirror the PUT lock: a submitted or approved expense can't be deleted out
    // from under the approval gate. Only an approver may, and then under the
    // approval rule: not their own while they have a supervisor. Deleting your
    // own approved expense is as much an approval decision as approving it.
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      if (!hasPermission(ctx.permissions, Permission.EXPENSE_APPROVE)) {
        return new Response(
          JSON.stringify({ error: "Only draft or rejected expenses can be deleted" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const authority = approvalAuthority({
        actorUserId: ctx.userId,
        subjectUserId: existing.createdById,
        hasTimeApprove: true,
        isManagerOfSubject:
          roleCountsFor(ctx, Permission.EXPENSE_APPROVE) && (await isManagerOf(orgId, ctx.userId, existing.createdById)),
        subjectHasManager: await hasManager(orgId, existing.createdById),
        noun: "expense",
      });
      if (!authority.allowed) {
        return new Response(
          JSON.stringify({ error: "Your own submitted or approved expense can only be deleted by your supervisor or another approver" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    await prisma.expense.delete({ where: { id: expenseId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.deleted",
      entity: "expense",
      entityId: expenseId,
      // The status says whether this removed a decision (an approved expense)
      // or just a draft.
      metadata: {
        amount: String(existing.amount),
        category: existing.category,
        status: existing.status,
        createdById: existing.createdById,
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
