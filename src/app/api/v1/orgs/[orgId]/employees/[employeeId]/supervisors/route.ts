import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { Permission, hasAnyPermission } from "@/lib/rbac/permissions";
import { ForbiddenError } from "@/lib/rbac/check";
import { setSupervisors } from "@/lib/org/supervisors";
import { assignableSupervisors } from "@/lib/org/assignable-supervisors";
import { createNotification } from "@/lib/notifications/create";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = {
  params: Promise<{ orgId: string; employeeId: string }>;
};

const bodySchema = z.object({
  /** Employee ids — NOT user ids. Empty clears every supervisor. */
  supervisorIds: z.array(z.string().uuid()).max(10),
});

/**
 * Who supervises this employee, and who MAY.
 *
 * Setting supervisors is deliberately NOT something the subject can do. A worker
 * who nominates their own approver defeats the control the approval workflow
 * exists to provide, so this needs a people- or finance-admin permission.
 * Either works: an HR admin without finance access still has to be able to run
 * the org chart, and gating on FINANCE_MANAGE alone (as the employee record
 * historically did) locks them out of it.
 */
function requireEmployeeAdmin(permissions: bigint): void {
  if (
    !hasAnyPermission(
      permissions,
      Permission.FINANCE_MANAGE,
      Permission.ORG_MANAGE_MEMBERS,
    )
  ) {
    throw new ForbiddenError("Missing required permission");
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, employeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requireEmployeeAdmin(ctx.permissions);

    // Scoped to the org, so an employee id from another tenant reads as absent
    // rather than exposing that it exists.
    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, orgId },
      select: { id: true },
    });
    if (!employee) return new Response("Not found", { status: 404 });

    const [current, candidates] = await Promise.all([
      prisma.employeeSupervisor.findMany({
        where: { orgId, employeeId },
        select: { supervisorId: true },
      }),
      assignableSupervisors(orgId, employeeId),
    ]);

    return success({
      supervisorIds: current.map((r) => r.supervisorId),
      candidates,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, employeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requireEmployeeAdmin(ctx.permissions);

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, orgId },
      select: { id: true, userId: true },
    });
    if (!employee) return new Response("Not found", { status: 404 });

    const { supervisorIds } = bodySchema.parse(await request.json());

    // Only people who actually hold TIME_APPROVE may be named. Without this the
    // chart could route a week to someone the authority check then refuses,
    // and the week would sit unapprovable with nobody realising why.
    const allowed = new Set(
      (await assignableSupervisors(orgId, employeeId)).map((c) => c.employeeId),
    );
    const rejected = supervisorIds.filter((id) => !allowed.has(id));
    if (rejected.length > 0) {
      return bad(
        "Those people cannot approve time, so they cannot be supervisors",
        422,
      );
    }

    const { added, removed } = await setSupervisors({
      orgId,
      employeeId,
      supervisorIds,
      actorId: ctx.userId,
    });

    if (added.length > 0 || removed.length > 0) {
      // ONE audit record for the change, carrying the resulting set — the
      // question an auditor asks is "who could approve this person's time on
      // that date", which a list of individual add/remove events answers only
      // by replaying them.
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "employee.supervisors_changed",
        entity: "employee",
        entityId: employeeId,
        metadata: { supervisorIds, added, removed },
        ipAddress: getIpAddress(request),
      });
    }

    await notifyNewSupervisors({ orgId, added, subjectUserId: employee.userId });

    return success({ supervisorIds, added, removed });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Tell people they have been made someone's supervisor.
 *
 * They are now accountable for approving that person's time; discovering it
 * when the first timesheet lands is too late, and a supervisor who disagrees
 * with the assignment needs a chance to say so. After the write and unable to
 * fail it — the assignment is the business event.
 */
async function notifyNewSupervisors(params: {
  orgId: string;
  added: string[];
  subjectUserId: string;
}): Promise<void> {
  if (params.added.length === 0) return;
  try {
    const [supervisors, subject] = await Promise.all([
      prisma.employee.findMany({
        where: { id: { in: params.added }, orgId: params.orgId },
        select: { userId: true },
      }),
      prisma.user.findUnique({
        where: { id: params.subjectUserId },
        select: { displayName: true },
      }),
    ]);
    const who = subject?.displayName?.trim() || "Someone";

    await Promise.all(
      supervisors.map((s) =>
        createNotification({
          orgId: params.orgId,
          userId: s.userId,
          type: "employee.supervisor_assigned",
          title: `You now approve ${who}'s time`,
          message: `${who}'s timesheets will be sent to you for approval.`,
          relatedType: "employee",
          relatedId: params.subjectUserId,
          url: "/time-tracking",
        }),
      ),
    );
  } catch {
    /* the assignment already committed — see the note above */
  }
}

function bad(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
