import { createNotification } from "@/lib/notifications/create";
import { formatDateStable } from "@/lib/format/stable-date";
import type { ApprovalRoute } from "./routing";

/**
 * Telling people a timesheet moved.
 *
 * Before this, submitting a week was silent: the worker did not know who it went
 * to, and the approver was never told it had arrived. Hours sat in SUBMITTED
 * until an admin happened to open the page.
 *
 * TWO RULES hold everything here together.
 *
 * 1. NEVER inside the transaction. `applyTimesheetTransition` writes the sheet
 *    and its entries atomically; a notification insert, an SSE publish and a
 *    web push are none of them things that should be able to hold that
 *    transaction open or roll an approval back. They run after the commit.
 *
 * 2. NEVER let a notification failure fail the action. The approval is the
 *    business event and it has already happened; a dead push subscription must
 *    not turn a successful approval into a 500 that invites the user to submit
 *    twice. Failures are swallowed here, on top of the per-channel swallowing
 *    inside createNotification, because the DB insert itself can still throw.
 */

/** The period a notification is about, formatted the way the UI shows it. */
function periodLabel(periodStart: Date, periodEnd: Date): string {
  return `${formatDateStable(periodStart)} – ${formatDateStable(periodEnd)}`;
}

/**
 * Deep link to the week in question.
 *
 * Org-RELATIVE, which is what the notification dropdown expects: it strips a
 * leading `/{orgSlug}` and re-adds exactly one, and the majority of existing
 * call sites store the relative form.
 */
function weekUrl(userId: string, periodStart: Date): string {
  const week = periodStart.toISOString().slice(0, 10);
  return `/time-tracking?userId=${userId}&week=${week}`;
}

/** Tell the approver(s) a week is waiting on them. */
export async function notifyTimesheetSubmitted(params: {
  orgId: string;
  timesheetId: string;
  workerUserId: string;
  workerName: string;
  periodStart: Date;
  periodEnd: Date;
  route: ApprovalRoute;
}): Promise<void> {
  const { route } = params;
  if (route.notify.length === 0) return;

  const period = periodLabel(params.periodStart, params.periodEnd);
  const url = weekUrl(params.workerUserId, params.periodStart);

  await Promise.all(
    route.notify.map((userId) =>
      safely(() =>
        createNotification({
          orgId: params.orgId,
          userId,
          type: "timesheet.submitted",
          title: `${params.workerName} submitted a timesheet`,
          message: `${period} is waiting for your approval.`,
          relatedType: "timesheet",
          relatedId: params.timesheetId,
          url,
        }),
      ),
    ),
  );
}

/**
 * Tell the WORKER what happened to their week.
 *
 * The other half of the loop, and just as missing: a worker whose week was
 * returned found out only by revisiting the page. A rejection they never see is
 * a week that never gets resubmitted.
 */
export async function notifyTimesheetDecision(params: {
  orgId: string;
  timesheetId: string;
  workerUserId: string;
  deciderName: string;
  decision: "approved" | "rejected";
  reason?: string | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const period = periodLabel(params.periodStart, params.periodEnd);
  const approved = params.decision === "approved";

  await safely(() =>
    createNotification({
      orgId: params.orgId,
      userId: params.workerUserId,
      type: approved ? "timesheet.approved" : "timesheet.returned",
      title: approved
        ? `${params.deciderName} approved your timesheet`
        : `${params.deciderName} returned your timesheet`,
      message: approved
        ? `${period} has been approved.`
        : // The reason is the whole point of a return: without it the worker is
          // told the week came back but not what to change.
          `${period} needs another look. ${params.reason ?? ""}`.trim(),
      relatedType: "timesheet",
      relatedId: params.timesheetId,
      url: weekUrl(params.workerUserId, params.periodStart),
    }),
  );
}

/** Run a side effect that must never fail the action it accompanies. */
async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* the business event already committed — see rule 2 above */
  }
}
