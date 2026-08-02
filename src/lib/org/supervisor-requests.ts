import { prisma } from "@/lib/db/client";
import { NotFoundError, ForbiddenError } from "@/lib/rbac/check";
import { assignableSupervisors } from "./assignable-supervisors";

/**
 * A worker asking to be given a supervisor.
 *
 * This exists because submission is refused without one. A block with no route
 * out is a dead end, and the route out cannot be "assign your own supervisor" —
 * that is precisely the control the approval workflow exists to provide. So the
 * worker REQUESTS and a permission-holder still performs the assignment.
 *
 * TWO NARROWINGS, both load-bearing:
 *
 * 1. You may only request for YOURSELF. There is no subject parameter — it is
 *    derived from the caller — so there is no authorization to get wrong.
 * 2. You may only ask people `assignableSupervisors` already offers. Without
 *    this the endpoint is an arbitrary notification cannon: name any user id and
 *    they get a message. It also keeps the request honest — asking someone who
 *    cannot approve time produces an assignment the picker would refuse.
 */
export interface SupervisorRequestResult {
  /** The REQUESTER's employee id — what the approver's deep link acts on. */
  employeeId: string;
  /** Rows actually created — the people to notify. Excludes ones already open. */
  created: Array<{ supervisorEmployeeId: string; supervisorUserId: string }>;
  /** Asked for but already pending, so nobody is pinged twice. */
  alreadyPending: string[];
}

export async function requestSupervisors(params: {
  orgId: string;
  /** The caller. Both the subject of the request and its author. */
  subjectUserId: string;
  /** Employee ids of the people being asked. */
  supervisorEmployeeIds: string[];
}): Promise<SupervisorRequestResult> {
  const { orgId, subjectUserId } = params;
  const wanted = [...new Set(params.supervisorEmployeeIds)];
  if (wanted.length === 0) {
    return { employeeId: "", created: [], alreadyPending: [] };
  }

  const employee = await prisma.employee.findFirst({
    where: { orgId, userId: subjectUserId },
    select: { id: true },
  });
  if (!employee) {
    // Supervision is employee-to-employee, so there is nothing to attach the
    // request to. The gate exempts these people from the block for the same
    // reason, so reaching here means the client asked for something the product
    // never offers.
    throw new NotFoundError("You do not have an employee record in this org");
  }

  const eligible = await assignableSupervisors(orgId, employee.id);
  const eligibleIds = new Set(eligible.map((c) => c.employeeId));
  const invalid = wanted.filter((id) => !eligibleIds.has(id));
  if (invalid.length > 0) {
    // Deliberately not "some of these were fine" — a partial success here would
    // let a caller probe which ids exist by watching what gets accepted.
    throw new ForbiddenError("Those people cannot be asked to supervise you");
  }

  // `skipDuplicates` rather than a read-then-write: two taps on the button
  // race, and the unique index is the real guard. What comes back is exactly
  // the rows that did not already exist, which is exactly who to notify — so
  // the spam guard and the notification list are the same decision, resolved
  // once, by the database.
  const created = await prisma.supervisorRequest.createManyAndReturn({
    data: wanted.map((supervisorId) => ({
      orgId,
      employeeId: employee.id,
      supervisorId,
      requestedById: subjectUserId,
    })),
    skipDuplicates: true,
    select: { supervisorId: true },
  });

  const createdIds = new Set(created.map((r) => r.supervisorId));
  const userIdOf = new Map(eligible.map((c) => [c.employeeId, c.userId]));

  return {
    employeeId: employee.id,
    created: created.map((r) => ({
      supervisorEmployeeId: r.supervisorId,
      // Present by construction: every id was checked against `eligible` above.
      supervisorUserId: userIdOf.get(r.supervisorId) ?? "",
    })),
    alreadyPending: wanted.filter((id) => !createdIds.has(id)),
  };
}

/**
 * Requests this employee has open, so the picker can show who has been asked.
 *
 * Returned as employee ids to match what the picker works in.
 */
export async function pendingRequestsFor(
  orgId: string,
  employeeId: string,
): Promise<string[]> {
  const rows = await prisma.supervisorRequest.findMany({
    where: { orgId, employeeId },
    select: { supervisorId: true },
  });
  return rows.map((r) => r.supervisorId);
}
