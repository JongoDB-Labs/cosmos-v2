import { prisma } from "@/lib/db/client";
import { ConflictError, NotFoundError } from "@/lib/rbac/check";

/**
 * The org chart, as a GRAPH.
 *
 * A worker can have several supervisors — a matrixed org, a deputy covering
 * leave, someone split across two programmes — which the old scalar
 * `Employee.managerId` could not express. Every question about supervision is
 * answered here so that time scoping, approval authority and the payroll UI
 * cannot drift apart; they previously each re-derived it from `managerId`.
 *
 * ONE RULE runs through all of it: supervision is set by someone holding the
 * permission to manage employees, NEVER by the subject. A worker who nominates
 * their own approver defeats the control the approval workflow exists to
 * provide. Candidates are further narrowed to people who actually hold
 * TIME_APPROVE, so an assigned supervisor is always someone `approvalAuthority`
 * would accept — otherwise the chart would happily name an approver the server
 * then refuses, and the week would deadlock.
 */

/** How far to walk before deciding the data is pathological. */
const MAX_CHAIN_DEPTH = 64;

/** User ids of everyone who supervises `subjectUserId`. */
export async function supervisorUserIdsOf(
  orgId: string,
  subjectUserId: string,
): Promise<string[]> {
  try {
    const rows = await prisma.employeeSupervisor.findMany({
      where: { orgId, employee: { orgId, userId: subjectUserId } },
      select: { supervisor: { select: { userId: true, orgId: true } } },
    });
    return [
      ...new Set(
        rows
          // The org guard is not redundant: employee_supervisors carries its own
          // org_id, but the supervisor row is reached through a bare FK.
          .filter((r) => r.supervisor?.orgId === orgId)
          .map((r) => r.supervisor.userId)
          // Self-supervision names nobody, and treating it as a supervisor
          // deadlocks the sheet: approvalAuthority refuses self-approval
          // whenever a supervisor exists.
          .filter((id) => id !== subjectUserId),
      ),
    ];
  } catch {
    // Fail CLOSED on the routing question: better to route to the approver pool
    // than to a supervisor we are not sure about.
    return [];
  }
}

/**
 * Does this person have a supervisor at all? Drives the self-approval rule.
 *
 * Fails SAFE toward the stricter answer: assume one exists, which refuses
 * self-approval rather than granting it on a lookup failure.
 */
export async function hasSupervisor(
  orgId: string,
  subjectUserId: string,
): Promise<boolean> {
  try {
    const rows = await prisma.employeeSupervisor.findMany({
      where: { orgId, employee: { orgId, userId: subjectUserId } },
      select: { supervisor: { select: { userId: true } } },
    });
    return rows.some((r) => r.supervisor?.userId !== subjectUserId);
  } catch {
    return true;
  }
}

/** Is `actorUserId` a supervisor of `subjectUserId` in this org? */
export async function isSupervisorOf(
  orgId: string,
  actorUserId: string,
  subjectUserId: string,
): Promise<boolean> {
  if (actorUserId === subjectUserId) return false;
  try {
    const hit = await prisma.employeeSupervisor.findFirst({
      where: {
        orgId,
        employee: { orgId, userId: subjectUserId },
        supervisor: { orgId, userId: actorUserId },
      },
      select: { id: true },
    });
    return Boolean(hit);
  } catch {
    // Fail CLOSED: an unresolvable relationship must not confer authority.
    return false;
  }
}

/**
 * Would making `supervisorId` supervise `employeeId` close a loop?
 *
 * Walks UP from the proposed supervisor across EVERY edge — with several
 * supervisors the chart is a DAG, not a chain, so following one parent per hop
 * (as the old `managerId` walk did) would miss a cycle that closes through a
 * second supervisor. Breadth-first with a `seen` set, so data that is already
 * cyclic terminates instead of spinning.
 */
export async function assertNoSupervisorCycle(
  orgId: string,
  employeeId: string,
  supervisorId: string,
): Promise<void> {
  if (supervisorId === employeeId) {
    throw new ConflictError("An employee cannot be their own supervisor");
  }

  const seen = new Set<string>([supervisorId]);
  let frontier = [supervisorId];

  for (let depth = 0; frontier.length > 0 && depth < MAX_CHAIN_DEPTH; depth++) {
    const rows = await prisma.employeeSupervisor.findMany({
      where: { orgId, employeeId: { in: frontier } },
      select: { supervisorId: true },
    });
    const next: string[] = [];
    for (const r of rows) {
      if (r.supervisorId === employeeId) {
        throw new ConflictError(
          "That supervisor already reports to this employee",
        );
      }
      if (seen.has(r.supervisorId)) continue;
      seen.add(r.supervisorId);
      next.push(r.supervisorId);
    }
    frontier = next;
  }
}

/** The proposed supervisor must be a real employee IN THIS ORG. The FK alone
 *  proves the row exists; it does not constrain it to the same tenant. */
export async function assertSupervisorInOrg(
  orgId: string,
  supervisorId: string,
): Promise<void> {
  const found = await prisma.employee.findFirst({
    where: { id: supervisorId, orgId },
    select: { id: true },
  });
  if (!found) {
    throw new NotFoundError("Supervisor is not an employee of this org");
  }
}

/**
 * Replace an employee's supervisors wholesale.
 *
 * A set operation rather than add/remove calls: the UI edits a list, and
 * expressing "these are now the supervisors" in one transaction means a partly
 * applied change can never be observed — which for an approval chart would mean
 * a window where a week routes to the wrong person or to nobody.
 *
 * Returns what actually changed, so the caller can write ONE audit record
 * describing the change rather than a row per edge, and notify only people
 * who were newly named.
 */
export async function setSupervisors(params: {
  orgId: string;
  employeeId: string;
  supervisorIds: string[];
  actorId: string;
}): Promise<{ added: string[]; removed: string[] }> {
  const { orgId, employeeId, actorId } = params;
  const desired = [...new Set(params.supervisorIds)];

  for (const id of desired) {
    await assertSupervisorInOrg(orgId, id);
    await assertNoSupervisorCycle(orgId, employeeId, id);
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.employeeSupervisor.findMany({
      where: { orgId, employeeId },
      select: { supervisorId: true },
    });
    const have = new Set(current.map((r) => r.supervisorId));
    const want = new Set(desired);

    const added = desired.filter((id) => !have.has(id));
    const removed = [...have].filter((id) => !want.has(id));

    if (removed.length > 0) {
      await tx.employeeSupervisor.deleteMany({
        where: { orgId, employeeId, supervisorId: { in: removed } },
      });
    }
    if (added.length > 0) {
      await tx.employeeSupervisor.createMany({
        data: added.map((supervisorId) => ({
          orgId,
          employeeId,
          supervisorId,
          createdById: actorId,
        })),
        skipDuplicates: true,
      });
    }
    return { added, removed };
  });
}
