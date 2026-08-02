import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { resolveApprovalRoute } from "@/lib/time/routing";
import { resolveSubmitGate } from "@/lib/time/submit-gate";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Where MY next submission would go — answered before I submit, not after.
 *
 * Finding out that nobody was asked to approve your week only once you have
 * already handed it in is too late: the hours sit in SUBMITTED and the worker
 * has no reason to suspect anything is wrong. This lets the Submit button say
 * who it is about to go to, and warn when the answer is nobody.
 *
 * Deliberately SELF-ONLY. It takes no userId: asking "who approves Alice's
 * time?" is an org-chart question, and this endpoint exists to answer a
 * worker's question about their own week. Keeping it self-scoped means there is
 * no parameter to get the authorization wrong on.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const [route, gate] = await Promise.all([
      resolveApprovalRoute(orgId, ctx.userId),
      resolveSubmitGate({
        orgId,
        subjectUserId: ctx.userId,
        canApproveOwnTime: hasPermission(ctx.permissions, Permission.TIME_APPROVE),
      }),
    ]);

    const names =
      route.notify.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: route.notify } },
            select: { displayName: true },
          })
        : [];

    return success({
      reason: route.reason,
      // Names only — the ids are of no use to the client and every id withheld
      // is one fewer handle on an org member.
      approverNames: names.map((u) => u.displayName),
      // Whether the Submit button will be REFUSED, answered before it is
      // pressed. This is not derivable from `reason`: the two nearly invert
      // each other. `reason: "none"` (nobody in the org can approve) is an
      // EXEMPTION and submits fine, while `reason: "admin_pool"` (approvers
      // exist, but none supervises you) is exactly the blocked case.
      canSubmit: gate.allowed,
      blockCode: gate.code ?? null,
      // Who this worker may ask, so the request modal opens already populated
      // rather than fetching again at the moment it is needed. Employee ids
      // are what the request endpoint accepts.
      eligibleSupervisors: gate.eligible.map((c) => ({
        employeeId: c.employeeId,
        displayName: c.displayName,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
