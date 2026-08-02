import { prisma } from "@/lib/db/client";
import { approversInOrg } from "@/lib/time/routing";

/**
 * Who may be OFFERED as a supervisor.
 *
 * Three narrowings, each for a different failure it prevents:
 *
 * 1. Must hold TIME_APPROVE (via org role, per-member override, or a work-role
 *    grant — `approversInOrg` folds all three). Naming someone who cannot
 *    approve produces a chart the server contradicts: the week routes to them,
 *    they are notified, and `approvalAuthority` then refuses their signature.
 *    Being a supervisor DOES confer authority on its own, so this is a policy
 *    choice rather than a correctness one — but it is the right one: an
 *    approver should be someone the organisation has deliberately trusted with
 *    approvals, not someone who becomes one as a side effect of a picker.
 * 2. Never the employee themselves.
 * 3. Never anyone who already reports up through them, which would close a
 *    loop. The server refuses it anyway (`assertNoSupervisorCycle`); excluding
 *    it here means the common case never reaches the user as an error.
 */
export interface SupervisorCandidate {
  /** Employee id — what the supervisor assignment stores. NOT a user id. */
  employeeId: string;
  userId: string;
  displayName: string | null;
  /**
   * False for someone ALREADY assigned who no longer holds TIME_APPROVE.
   *
   * They are listed so the assignment stays visible and removable — see
   * `withCurrent` — but the UI should mark them, because they are there by
   * history rather than by policy.
   */
  canApprove: boolean;
}

/**
 * Candidates, PLUS anyone already assigned who would not otherwise qualify.
 *
 * Without this, restricting candidates to TIME_APPROVE holders quietly bricks
 * an existing assignment: the supervisor vanishes from the list, the picker
 * claims nobody can approve, and saving is refused because the unchanged set
 * now contains an id the server will not accept. Losing a permission must not
 * make a record unsaveable.
 *
 * Note that a grandfathered supervisor can still genuinely approve — supervising
 * a report confers authority on its own (`approvalAuthority`). The TIME_APPROVE
 * restriction is a policy about who may be NEWLY named, not a correctness rule.
 */
export async function supervisorPickerOptions(
  orgId: string,
  employeeId: string,
): Promise<{
  options: SupervisorCandidate[];
  addableIds: string[];
  /**
   * People who CAN approve time but have no employee record, so they cannot be
   * offered — supervision is modelled employee-to-employee.
   *
   * Named rather than merely counted, because without this the picker blamed
   * the wrong thing: it said "nobody in this organisation can approve time yet"
   * to someone who had just granted the Reviewer / Approver role, sending them
   * to redo the step they had already done. The real fix is to add that person
   * as an employee, and the message can only say so if it knows who they are.
   */
  approversMissingEmployeeRecord: string[];
}> {
  const [candidates, current, stranded] = await Promise.all([
    assignableSupervisors(orgId, employeeId),
    prisma.employeeSupervisor.findMany({
      where: { orgId, employeeId },
      select: { supervisorId: true },
    }),
    approversMissingEmployeeRecord(orgId),
  ]);

  const addableIds = candidates.map((c) => c.employeeId);
  const known = new Set(addableIds);
  const missing = current
    .map((r) => r.supervisorId)
    .filter((id) => !known.has(id));
  if (missing.length === 0) {
    return {
      options: candidates,
      addableIds,
      approversMissingEmployeeRecord: stranded,
    };
  }

  const rows = await prisma.employee.findMany({
    where: { id: { in: missing }, orgId },
    select: { id: true, userId: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));

  const grandfathered = rows.map((r) => ({
    employeeId: r.id,
    userId: r.userId,
    displayName: nameOf.get(r.userId) ?? null,
    canApprove: false,
  }));

  return {
    options: [...candidates, ...grandfathered].sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    ),
    addableIds,
    approversMissingEmployeeRecord: stranded,
  };
}

/**
 * People who hold TIME_APPROVE but have no employee record.
 *
 * They are the reason a picker can be empty in an org that HAS approvers, and
 * naming them is the difference between "grant somebody the role" (which the
 * admin has already done) and "add Michael as an employee" (which is the
 * actual fix).
 */
export async function approversMissingEmployeeRecord(
  orgId: string,
): Promise<string[]> {
  const approverUserIds = await approversInOrg(orgId);
  if (approverUserIds.length === 0) return [];

  const employees = await prisma.employee.findMany({
    where: { orgId, userId: { in: approverUserIds } },
    select: { userId: true },
  });
  const haveRecord = new Set(employees.map((e) => e.userId));
  const stranded = approverUserIds.filter((id) => !haveRecord.has(id));
  if (stranded.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: stranded } },
    select: { displayName: true },
  });
  return users.map((u) => u.displayName).filter(Boolean).sort();
}

export async function assignableSupervisors(
  orgId: string,
  employeeId: string,
): Promise<SupervisorCandidate[]> {
  const [approverUserIds, employees, edges] = await Promise.all([
    approversInOrg(orgId),
    prisma.employee.findMany({
      where: { orgId, status: "active" },
      // Employee carries a bare `userId` with no `user` relation, so names come
      // from a separate lookup below rather than an include.
      select: { id: true, userId: true },
    }),
    prisma.employeeSupervisor.findMany({
      where: { orgId },
      select: { employeeId: true, supervisorId: true },
    }),
  ]);

  const approvers = new Set(approverUserIds);
  const below = descendantsOf(edges, employeeId);

  const eligible = employees.filter(
    (e) => e.id !== employeeId && !below.has(e.id) && approvers.has(e.userId),
  );
  if (eligible.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: eligible.map((e) => e.userId) } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));

  return eligible
    .map((e) => ({
      employeeId: e.id,
      userId: e.userId,
      displayName: nameOf.get(e.userId) ?? null,
      canApprove: true,
    }))
    .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""));
}

/**
 * Everyone who reports up through `rootId`, directly or otherwise.
 *
 * Iterative and guarded by `seen`, so a chart that ALREADY contains a cycle
 * terminates instead of overflowing the stack — never assume stored data is
 * acyclic just because the write path checks.
 */
export function descendantsOf(
  edges: Array<{ employeeId: string; supervisorId: string }>,
  rootId: string,
): Set<string> {
  const reportsTo = new Map<string, string[]>();
  for (const e of edges) {
    const existing = reportsTo.get(e.supervisorId);
    if (existing) existing.push(e.employeeId);
    else reportsTo.set(e.supervisorId, [e.employeeId]);
  }

  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const childId of reportsTo.get(id) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return seen;
}
