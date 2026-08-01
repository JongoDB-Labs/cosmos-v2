import { prisma } from "@/lib/db/client";
import { resolvePermissions } from "@/lib/rbac/check";
import { supervisorUserIdsOf } from "@/lib/org/supervisors";
import { Permission, hasPermission, maskFromDb } from "@/lib/rbac/permissions";

/**
 * Who a submitted timesheet is handed to.
 *
 * Before this, submitting flipped a status and told nobody. The worker's own
 * question — "who am I submitting this week TO?" — had no answer, and hours sat
 * in SUBMITTED until an admin happened to look.
 *
 * ROUTING IS NOT AUTHORIZATION. This decides who is ASKED; `approvalAuthority`
 * still decides who MAY sign, and the two are deliberately different sets:
 *
 *   - Locking approval to the stamped approver would deadlock every sheet whose
 *     approver leaves, goes on leave, or is deleted.
 *   - Deriving the approver at read time instead of stamping it would rewrite
 *     history: reorganise the org chart and last quarter's timesheets would
 *     silently claim they had been routed to someone who was not there yet.
 *
 * So both are recorded. `approverId` is who we asked, fixed at submit time;
 * `laborApprovedById` is who actually signed. An auditor needs both, and they
 * are not always the same person.
 */
export type RouteReason =
  /** The org chart names a supervisor. */
  | "manager"
  /** No supervisor, so it falls to whoever may approve in this org. */
  | "admin_pool"
  /** Nobody else can approve it — the top of the org chart, or an org of one. */
  | "none";

export interface ApprovalRoute {
  /**
   * The designated approver when the org chart names exactly one, else null.
   * Only ever used for wording ("Submitted to Jane"); the authoritative record
   * of who was asked is `notify`, which is what gets stamped on the sheet.
   */
  approverId: string | null;
  /** Everyone asked, and everyone notified. Never includes the worker. */
  notify: string[];
  reason: RouteReason;
}

/**
 * The routing decision, as a pure function.
 *
 * The subject is dropped from their own supervisor list: an employee record
 * that supervises itself names no supervisor, and treating it as one deadlocks
 * the sheet outright — `approvalAuthority` refuses self-approval whenever a
 * supervisor exists, so a self-supervised worker could neither approve their
 * own sheet nor have anyone else's authority apply.
 *
 * ALL supervisors are notified, not the "first" one. With several, picking one
 * silently would leave a week waiting on somebody who may be on leave —
 * precisely the situation multiple supervisors exist to cover.
 */
export function routeFor(params: {
  subjectUserId: string;
  supervisorUserIds: string[];
  /** Everyone in the org who may approve, including possibly the subject. */
  approverUserIds: string[];
}): ApprovalRoute {
  const { subjectUserId, approverUserIds } = params;
  const supervisors = [...new Set(params.supervisorUserIds)].filter(
    (id) => id !== subjectUserId,
  );

  if (supervisors.length > 0) {
    return {
      // Named only when exactly one, and used for wording alone. With several
      // there is no "the" approver, and inventing one would misreport the chart.
      approverId: supervisors.length === 1 ? supervisors[0] : null,
      notify: supervisors,
      reason: "manager",
    };
  }

  // Self is filtered from the pool: telling someone their own timesheet needs
  // their attention is noise, and where they are the only approver they will
  // sign it themselves anyway.
  const pool = [...new Set(approverUserIds)].filter((id) => id !== subjectUserId);
  if (pool.length > 0) {
    return { approverId: null, notify: pool, reason: "admin_pool" };
  }

  return { approverId: null, notify: [], reason: "none" };
}

/**
 * Every user in the org who may approve a timesheet.
 *
 * Folds work-role grants in, exactly as `loadEffectivePermissions` does for a
 * single actor. Skipping them would produce a queue that disagrees with the
 * authority check: someone granted TIME_APPROVE through a work-role could
 * approve a sheet they were never shown.
 *
 * One query rather than N calls to `loadEffectivePermissions`, because this
 * runs on every submit.
 */
export async function approversInOrg(orgId: string): Promise<string[]> {
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    select: {
      userId: true,
      role: true,
      permissions: true,
      workRoles: { select: { workRole: { select: { grants: true } } } },
    },
  });

  return members
    .filter((m) => {
      let effective = resolvePermissions(m.role, maskFromDb(m.permissions));
      for (const assignment of m.workRoles) {
        effective |= maskFromDb(assignment.workRole.grants);
      }
      return hasPermission(effective, Permission.TIME_APPROVE);
    })
    .map((m) => m.userId);
}

/** Resolve the full route for a submission. */
export async function resolveApprovalRoute(
  orgId: string,
  subjectUserId: string,
): Promise<ApprovalRoute> {
  const [supervisorUserIds, approverUserIds] = await Promise.all([
    supervisorUserIdsOf(orgId, subjectUserId),
    approversInOrg(orgId),
  ]);
  return routeFor({ subjectUserId, supervisorUserIds, approverUserIds });
}
