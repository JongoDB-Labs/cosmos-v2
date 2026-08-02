import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { requestSupervisors } from "@/lib/org/supervisor-requests";
import { notifySupervisorRequested } from "@/lib/org/notify";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({
  /** Employee ids of the people being asked. */
  supervisorEmployeeIds: z.array(z.string().uuid()).min(1).max(10),
});

/**
 * "Please supervise me" — the way out of a blocked submission.
 *
 * DELIBERATELY SELF-ONLY, like `my-approvers`. It takes no subject: you may
 * only request a supervisor for yourself, so there is no parameter on which to
 * get the authorization wrong. TIME_READ is the gate because this is a worker
 * acting on their own timekeeping, not an HR action — requiring FINANCE_MANAGE
 * here would mean only the people who can already ASSIGN a supervisor could ask
 * for one, which is nobody who needs it.
 *
 * The assignment itself still belongs to a permission-holder. This endpoint
 * creates a request and notifies them; it never writes an `employee_supervisors`
 * row. That separation is the segregation of duties the whole approval workflow
 * depends on.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const body = bodySchema.parse(await request.json());

    const result = await requestSupervisors({
      orgId,
      subjectUserId: ctx.userId,
      supervisorEmployeeIds: body.supervisorEmployeeIds,
    });

    // Audited even when nothing was created: "asked again" is a fact about
    // behaviour worth having, and the row-level dedupe hides it otherwise.
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "employee.supervisor_requested",
      entity: "employee",
      entityId: ctx.userId,
      ipAddress: getIpAddress(request),
      metadata: {
        requested: body.supervisorEmployeeIds.length,
        created: result.created.length,
      },
    });

    if (result.created.length > 0) {
      const me = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { displayName: true },
      });
      await notifySupervisorRequested({
        orgId,
        supervisorUserIds: result.created.map((c) => c.supervisorUserId),
        requesterName: me?.displayName?.trim() || "A colleague",
        // The REQUESTER's record — the person the approver has to act on. The
        // supervisor's own id here would deep-link them to themselves.
        employeeId: result.employeeId,
      });
    }

    return success({
      requested: result.created.length,
      // Named so the client can say "you already asked Bob" rather than
      // silently doing nothing, which reads as a broken button.
      alreadyPending: result.alreadyPending.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
