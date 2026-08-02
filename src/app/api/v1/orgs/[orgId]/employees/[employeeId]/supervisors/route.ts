import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireEmployeeAdmin } from "@/lib/rbac/employee-admin";
import { setSupervisors } from "@/lib/org/supervisors";
import { supervisorPickerOptions } from "@/lib/org/assignable-supervisors";
import { pendingRequestsFor } from "@/lib/org/supervisor-requests";
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
 * Gated by `requireEmployeeAdmin` — see `@/lib/rbac/employee-admin` for why
 * either the finance or the people-admin permission is enough.
 */
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

    const [current, picker, requested] = await Promise.all([
      prisma.employeeSupervisor.findMany({
        where: { orgId, employeeId },
        select: { supervisorId: true },
      }),
      supervisorPickerOptions(orgId, employeeId),
      pendingRequestsFor(orgId, employeeId),
    ]);

    return success({
      supervisorIds: current.map((r) => r.supervisorId),
      // Includes anyone already assigned who no longer qualifies, so an
      // existing assignment stays visible and removable.
      candidates: picker.options,
      // Names, not a count: the picker used to blame "nobody can approve time"
      // when the real cause was an approver with no employee record.
      approversMissingEmployeeRecord: picker.approversMissingEmployeeRecord,
      // Who this person has ASKED to supervise them. The notification tells an
      // approver they were asked and deep-links here; without this the picker
      // that opens looks identical to any other, and they have to trust their
      // memory of the notification to know they are in the right place.
      requestedIds: requested,
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

    // Only people who hold TIME_APPROVE may be NEWLY named, so the chart cannot
    // start routing weeks to someone the org has not trusted with approvals.
    //
    // Checked against what is being ADDED, not the whole set: a supervisor who
    // has since lost the permission must still be removable, and re-saving an
    // unchanged list must not fail. Validating the whole set is how a permission
    // change quietly makes a record unsaveable.
    const existing = new Set(
      (
        await prisma.employeeSupervisor.findMany({
          where: { orgId, employeeId },
          select: { supervisorId: true },
        })
      ).map((r) => r.supervisorId),
    );
    const addable = new Set((await supervisorPickerOptions(orgId, employeeId)).addableIds);
    const rejected = supervisorIds.filter(
      (id) => !existing.has(id) && !addable.has(id),
    );
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
