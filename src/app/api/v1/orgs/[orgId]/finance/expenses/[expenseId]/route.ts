import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateExpenseSchema = z.object({
  amount: z.number().positive().optional(),
  currency: z.string().max(10).nullish(),
  date: z.string().nullish(),
  category: z.string().min(1).optional(),
  vendor: z.string().nullish(),
  description: z.string().nullish(),
  recurring: z.boolean().optional(),
  clinId: z.string().uuid().nullish(),
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

    if (!expense) return new Response("Not found", { status: 404 });

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
    if (!existing) return new Response("Not found", { status: 404 });

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

    const body = await request.json();
    const data = updateExpenseSchema.parse(body);

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
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: FINANCE_MANAGE bitfield check + any narrowing deny
    // policy (by ownership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "FINANCE_MANAGE", { createdById: existing.createdById });

    // Mirror the PUT lock: submitted/approved expenses can't be deleted out from
    // under the approval gate unless the actor is an approver/admin.
    if (
      existing.status !== "DRAFT" &&
      existing.status !== "REJECTED" &&
      !hasPermission(ctx.permissions, Permission.EXPENSE_APPROVE)
    ) {
      return new Response(
        JSON.stringify({ error: "Only draft or rejected expenses can be deleted" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await prisma.expense.delete({ where: { id: expenseId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.deleted",
      entity: "expense",
      entityId: expenseId,
      metadata: { amount: String(existing.amount), category: existing.category } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
