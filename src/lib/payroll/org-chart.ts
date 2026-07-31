/** Minimal shape the org-chart helpers need. */
export type ChartNode = { id: string; managerId?: string | null };

/**
 * Every employee below `rootId` in the reporting chain.
 *
 * Used to keep the supervisor picker from OFFERING a choice the server will
 * reject: making your own report your supervisor closes a loop. The server
 * still refuses it (`assertNoManagerCycle`) — this is so the common case never
 * reaches the server as an error the user has to read and undo.
 *
 * Iterative rather than recursive, and guarded by the `seen` set, so data that
 * already contains a cycle terminates instead of overflowing the stack. A
 * client must never assume the rows it was handed are acyclic.
 */
export function descendantIds<T extends ChartNode>(
  employees: T[],
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of employees) {
    if (!e.managerId) continue;
    const siblings = childrenOf.get(e.managerId);
    if (siblings) siblings.push(e.id);
    else childrenOf.set(e.managerId, [e.id]);
  }

  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const childId of childrenOf.get(id) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return seen;
}

/**
 * Who may be offered as `employee`'s supervisor: everyone except themselves and
 * anyone already reporting up through them.
 */
export function supervisorCandidates<T extends ChartNode>(
  employees: T[],
  employeeId: string,
): T[] {
  const below = descendantIds(employees, employeeId);
  return employees.filter((e) => e.id !== employeeId && !below.has(e.id));
}
