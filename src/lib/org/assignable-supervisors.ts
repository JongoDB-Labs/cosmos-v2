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
