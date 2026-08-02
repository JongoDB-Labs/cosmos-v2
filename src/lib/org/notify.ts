import { createNotification } from "@/lib/notifications/create";

/**
 * Telling an approver that somebody has asked them to supervise their time.
 *
 * The request is only half the flow: the worker is blocked from submitting
 * until an approver acts, so a request nobody is told about leaves them blocked
 * indefinitely — the same silent dead end the whole routing work set out to
 * remove.
 *
 * Same two rules as `lib/time/notify.ts`: never inside the transaction, and a
 * notification failure must never fail the action. The request row is the
 * business event and it has already committed; a dead push subscription must not
 * turn it into a 500 that invites the worker to ask again.
 */
export async function notifySupervisorRequested(params: {
  orgId: string;
  /** User ids of the people being asked. */
  supervisorUserIds: string[];
  requesterName: string;
  /** The requester's employee id — what the payroll picker acts on. */
  employeeId: string;
}): Promise<void> {
  if (params.supervisorUserIds.length === 0) return;

  await Promise.all(
    params.supervisorUserIds.map((userId) =>
      safely(() =>
        createNotification({
          orgId: params.orgId,
          userId,
          type: "employee.supervisor_requested",
          title: `${params.requesterName} asked you to be their supervisor`,
          // Says what to DO, not just what happened: the approver has to make
          // the assignment, and the deep link lands them where it is made.
          message:
            "They cannot submit a timesheet until someone supervises them. Add yourself under Accounting → Payroll.",
          relatedType: "employee",
          relatedId: params.employeeId,
          // Org-RELATIVE, which is what the notification dropdown expects: it
          // strips a leading /{orgSlug} and re-adds exactly one.
          url: "/accounting/payroll",
        }),
      ),
    ),
  );
}

/** Run a side effect that must never fail the action it accompanies. */
async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* the request row already committed — see the header */
  }
}
