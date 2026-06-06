import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; expenseId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
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

    if (existing.createdById !== ctx.userId) {
      return new Response(
        JSON.stringify({ error: "You can only submit your own expenses" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // DRAFT or REJECTED may be (re)submitted; SUBMITTED/APPROVED may not.
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      return new Response(
        JSON.stringify({ error: "Only draft or rejected expenses can be submitted" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await prisma.expense.update({
      where: { id: expenseId },
      // Clear any prior decision so a re-submitted (previously REJECTED) expense
      // doesn't carry a stale rejecter/timestamp while pending.
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        approvedById: null,
        approvedAt: null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.submitted",
      entity: "expense",
      entityId: expenseId,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
