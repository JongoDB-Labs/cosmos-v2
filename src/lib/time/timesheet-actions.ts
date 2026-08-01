import { prisma } from "@/lib/db/client";
import type { TimesheetStatus } from "@prisma/client";
import { entryStatusFor, type ApprovalLane } from "./approval";
import { NOT_VOIDED } from "./not-voided";

/**
 * Apply a timesheet transition, and carry the entries with it — atomically.
 *
 * `TimeEntry.status` stays authoritative for CLIN burn, payroll pricing and the
 * finance summary, all of which filter `status: "APPROVED"`. Rather than
 * rewrite those to join through the timesheet, the transition propagates. The
 * timesheet is the single source of truth; the entry field is a projection of
 * it, updated in the SAME transaction so the two can never be observed
 * disagreeing — a half-applied approval would show hours as billable that
 * nobody approved.
 *
 * Voided entries are excluded: they are withdrawn, and approving a timesheet
 * must not quietly bring them back (see not-voided.ts).
 *
 * Deliberately writes NO per-entry revision. One approval is ONE event, and it
 * is recorded on the timesheet with its approver and timestamp. Fanning it out
 * to a revision per entry would bury the real edits under bulk noise.
 */
export async function applyTimesheetTransition(params: {
  orgId: string;
  timesheetId: string;
  next: TimesheetStatus;
  actorId: string;
  lane?: ApprovalLane;
  rejectedReason?: string | null;
  /**
   * Everyone the submission is routed to, resolved at submit time. Undefined
   * leaves the existing stamp untouched; an EMPTY array is meaningful — "nobody
   * could approve this" — so it is written rather than skipped.
   */
  approverIds?: string[];
}) {
  const { orgId, timesheetId, next, actorId, lane } = params;
  const now = new Date();

  const sheetData: Record<string, unknown> = { status: next };
  if (next === "SUBMITTED") {
    sheetData.submittedAt = now;
    // Clear a previous rejection: the sheet is back in play, and a stale
    // reason shown against a resubmitted week reads as a fresh complaint.
    sheetData.rejectedReason = null;
  }
  if (params.approverIds !== undefined) {
    sheetData.approverIds = params.approverIds;
  }
  if (lane === "labor") {
    sheetData.laborApprovedById = actorId;
    sheetData.laborApprovedAt = now;
  }
  if (lane === "cost") {
    sheetData.costApprovedById = actorId;
    sheetData.costApprovedAt = now;
  }
  if (next === "OPEN") {
    // Withdrawn: the sheet was never handed over, so it should not look like it
    // was. A stale submittedAt would make a re-submission look like a duplicate,
    // and a stale approver would keep the week sitting in someone's queue after
    // the worker pulled it back.
    sheetData.submittedAt = null;
    sheetData.rejectedReason = null;
    sheetData.approverIds = [];
  }
  if (next === "REJECTED") {
    sheetData.rejectedReason = params.rejectedReason ?? null;
    // Approval stamps are cleared so a later re-approval cannot inherit a
    // signature from the round that was rejected.
    sheetData.laborApprovedById = null;
    sheetData.laborApprovedAt = null;
    sheetData.costApprovedById = null;
    sheetData.costApprovedAt = null;
  }

  const entryStatus = entryStatusFor(next);

  return prisma.$transaction(async (tx) => {
    const sheet = await tx.timesheet.update({
      where: { id: timesheetId },
      data: sheetData,
    });

    await tx.timeEntry.updateMany({
      where: { orgId, timesheetId, ...NOT_VOIDED },
      data: {
        status: entryStatus,
        // Approver provenance on the entry mirrors the timesheet's, so the
        // existing per-entry approval columns stay meaningful.
        ...(entryStatus === "APPROVED"
          ? { approvedById: actorId, approvedAt: now }
          : { approvedById: null, approvedAt: null }),
      },
    });

    return sheet;
  });
}

/** Is `actorUserId` the direct manager of `subjectUserId` in this org? */
export async function isManagerOf(
  orgId: string,
  actorUserId: string,
  subjectUserId: string,
): Promise<boolean> {
  try {
    const subject = await prisma.employee.findFirst({
      where: { orgId, userId: subjectUserId },
      select: { manager: { select: { userId: true, orgId: true } } },
    });
    return (
      subject?.manager?.userId === actorUserId &&
      subject?.manager?.orgId === orgId
    );
  } catch {
    // Fail CLOSED: an unresolvable relationship must not confer authority.
    return false;
  }
}

/**
 * Does this person have a supervisor at all? Drives the self-approval rule.
 *
 * A self-referential employee record names NO supervisor. Counting it as one
 * deadlocks the sheet outright: `approvalAuthority` refuses self-approval
 * whenever a manager exists, so the worker could neither sign their own week nor
 * be covered by anyone else's authority, and nothing in the schema prevents a
 * record from pointing at itself. Kept in step with `routeFor`, which drops a
 * self-manager for the same reason — the two must agree or a sheet is routed to
 * someone the authority check will not accept.
 */
export async function hasManager(
  orgId: string,
  subjectUserId: string,
): Promise<boolean> {
  try {
    const employee = await prisma.employee.findFirst({
      where: { orgId, userId: subjectUserId },
      select: { id: true, managerId: true },
    });
    if (!employee?.managerId) return false;
    return employee.managerId !== employee.id;
  } catch {
    // Fail SAFE toward the stricter rule: assume a supervisor exists, which
    // refuses self-approval rather than granting it on a lookup failure.
    return true;
  }
}
