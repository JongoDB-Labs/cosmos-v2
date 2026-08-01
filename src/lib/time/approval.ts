import type { TimesheetStatus } from "@prisma/client";

/**
 * The timesheet approval state machine, as a pure function.
 *
 * Approval is a PERIOD-level action, not an entry-level one. Every real
 * timekeeping system works this way, and the reason is not taste: submitting
 * entries individually produces periods that are half-submitted, which no
 * approver, payroll run or auditor can interpret. The per-entry submit that
 * used to exist is what this replaces.
 *
 * Two lanes, because approval answers two questions that are frequently held by
 * different people:
 *
 *   labor — were these hours actually worked?        (the people manager)
 *   cost  — are they chargeable to my project/CLIN?  (the project/CLIN owner)
 *
 * An org that needs only the first sets `requireCostApproval: false` and never
 * sees the second. Collapsing them entirely is how unallowable cost reaches a
 * contract, which is why the machine models both even when one is disabled.
 */
export type ApprovalLane = "labor" | "cost";

export type LaneConfig = {
  /** When false, labor approval alone completes the timesheet. */
  requireCostApproval: boolean;
};

export type TransitionOk = { ok: true; next: TimesheetStatus };
export type TransitionErr = { ok: false; reason: string };
export type Transition = TransitionOk | TransitionErr;

/** Statuses a worker may still edit entries in. */
export const EDITABLE_STATUSES: TimesheetStatus[] = ["OPEN", "REJECTED"];

/** Submitting hands the period to an approver. Only from a state the worker owns. */
export function submitTransition(current: TimesheetStatus): Transition {
  if (current === "OPEN" || current === "REJECTED") {
    return { ok: true, next: "SUBMITTED" };
  }
  if (current === "SUBMITTED" || current === "LABOR_APPROVED") {
    return { ok: false, reason: "This timesheet has already been submitted" };
  }
  if (current === "APPROVED") {
    return { ok: false, reason: "This timesheet has already been approved" };
  }
  return { ok: false, reason: "This timesheet is locked" };
}

/**
 * Approving one lane.
 *
 * With the cost lane disabled, labor approval completes the timesheet outright.
 * With it enabled the lanes are ORDERED — labor first — so that "chargeable to
 * my project" is never asserted about hours nobody has confirmed were worked.
 */
export function approveTransition(
  current: TimesheetStatus,
  lane: ApprovalLane,
  config: LaneConfig,
): Transition {
  if (current === "APPROVED") {
    return { ok: false, reason: "This timesheet is already approved" };
  }
  if (current === "LOCKED") {
    return { ok: false, reason: "This timesheet is locked" };
  }
  if (current === "OPEN" || current === "REJECTED") {
    return { ok: false, reason: "This timesheet has not been submitted yet" };
  }

  if (lane === "labor") {
    if (current !== "SUBMITTED") {
      return { ok: false, reason: "Labor approval has already been given" };
    }
    return {
      ok: true,
      next: config.requireCostApproval ? "LABOR_APPROVED" : "APPROVED",
    };
  }

  // cost lane
  if (!config.requireCostApproval) {
    return { ok: false, reason: "This organisation does not use cost approval" };
  }
  if (current !== "LABOR_APPROVED") {
    return { ok: false, reason: "Labor approval is required first" };
  }
  return { ok: true, next: "APPROVED" };
}

/**
 * Withdrawing a submission — the worker taking their OWN week back.
 *
 * Without this, someone who submitted the wrong week or forgot an entry has no
 * route back: their only option is to ask an approver to REJECT it, which
 * stamps a rejection reason and reads to everyone as "your supervisor bounced
 * this" rather than "I withdrew it". Two different events should not share one
 * record.
 *
 * Refused the moment an approver has signed ANY lane. Status alone already
 * excludes that today (approving moves the sheet off SUBMITTED), but the stamp
 * is checked too: a future lane configuration could leave a signature on a
 * still-SUBMITTED sheet, and silently pulling back hours an approver has
 * already accepted is precisely what an audit trail exists to prevent.
 */
export function withdrawTransition(
  current: TimesheetStatus,
  anyApprovalSigned: boolean,
): Transition {
  if (anyApprovalSigned) {
    return {
      ok: false,
      reason: "This timesheet has already been approved and cannot be withdrawn",
    };
  }
  if (current === "SUBMITTED") return { ok: true, next: "OPEN" };
  if (current === "OPEN" || current === "REJECTED") {
    return { ok: false, reason: "This timesheet has not been submitted" };
  }
  if (current === "LOCKED") return { ok: false, reason: "This timesheet is locked" };
  return {
    ok: false,
    reason: "This timesheet has already been approved and cannot be withdrawn",
  };
}

/** Rejection sends the period back to the worker, from either approval state. */
export function rejectTransition(current: TimesheetStatus): Transition {
  if (current === "SUBMITTED" || current === "LABOR_APPROVED") {
    return { ok: true, next: "REJECTED" };
  }
  if (current === "APPROVED") {
    // Deliberate: reversing an approval is a CORRECTION, not a rejection, and
    // needs its own path with its own record. Silently reopening approved
    // hours is exactly what an audit trail exists to prevent.
    return { ok: false, reason: "An approved timesheet cannot be rejected" };
  }
  if (current === "LOCKED") return { ok: false, reason: "This timesheet is locked" };
  return { ok: false, reason: "This timesheet has not been submitted yet" };
}

/**
 * The entry status that mirrors a timesheet status.
 *
 * `TimeEntry.status` stays authoritative for CLIN burn (`lib/pm/burn.ts`),
 * payroll pricing and the finance summary — all of which filter
 * `status: "APPROVED"`. Rather than rewrite those consumers to join through the
 * timesheet, timesheet transitions PROPAGATE here. One source of truth (the
 * timesheet), one derived field kept in lockstep, and no money-reporting query
 * has to change.
 */
export function entryStatusFor(
  status: TimesheetStatus,
): "DRAFT" | "SUBMITTED" | "APPROVED" {
  switch (status) {
    case "SUBMITTED":
    case "LABOR_APPROVED":
      return "SUBMITTED";
    case "APPROVED":
    case "LOCKED":
      return "APPROVED";
    // OPEN and REJECTED both mean "back with the worker".
    default:
      return "DRAFT";
  }
}

/**
 * May this actor approve a timesheet belonging to `subjectUserId`?
 *
 * Authority is a WIDENING (an approver reaching beyond their own rows), so it
 * lives here rather than in ABAC — that engine can only narrow. An org that
 * wants to restrict admins to their own reports authors a deny over
 * `is_manager_of_assignee`, which narrows this result.
 *
 * Self-approval is refused when the person HAS a manager: someone else is
 * designated, so approving your own hours bypasses them. With no manager
 * nobody else is designated and refusing would simply deadlock — the top of an
 * org chart has no one above it.
 */
export function approvalAuthority(params: {
  actorUserId: string;
  subjectUserId: string;
  hasTimeApprove: boolean;
  isManagerOfSubject: boolean;
  subjectHasManager: boolean;
}): { allowed: boolean; reason?: string } {
  const isSelf = params.actorUserId === params.subjectUserId;

  if (isSelf && params.subjectHasManager) {
    return {
      allowed: false,
      reason: "Your own timesheet has to be approved by your supervisor",
    };
  }

  if (params.isManagerOfSubject) return { allowed: true };
  if (params.hasTimeApprove) return { allowed: true };

  return { allowed: false, reason: "You cannot approve this timesheet" };
}
