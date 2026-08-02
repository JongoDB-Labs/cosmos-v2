import { prisma } from "@/lib/db/client";
import { hasSupervisor } from "@/lib/org/supervisors";
import {
  assignableSupervisors,
  type SupervisorCandidate,
} from "@/lib/org/assignable-supervisors";

/**
 * May this worker hand in a week at all?
 *
 * A week submitted by someone with no supervisor routes to the admin pool or to
 * nobody — it is recorded, nobody is named, and it sits unapproved until an
 * admin happens to look. Refusing the submission turns that silent dead end into
 * a prompt to get a supervisor assigned.
 *
 * THE THREE EXEMPTIONS ARE THE WHOLE DESIGN. The block itself is two lines; each
 * exemption exists because without it the rule locks somebody out of recording
 * their own time, with no route out from inside the product.
 *
 * This is a data-hygiene control, NOT a security one. Nobody gains access by
 * submitting unsupervised — the week simply lands where it lands today. So every
 * ambiguous case resolves toward ALLOW: the worst outcome of a false allow is an
 * unrouted week (the status quo), and the worst outcome of a false block is a
 * company that cannot record time. Those are not comparable, and the asymmetry
 * is why the resolver below fails open on error.
 */
export type SubmitBlockCode = "SUPERVISOR_REQUIRED";

export interface SubmitGate {
  allowed: boolean;
  /**
   * Machine-readable, so the client can open the request-a-supervisor flow
   * instead of string-matching the prose. Prose gets rewritten; codes do not.
   */
  code?: SubmitBlockCode;
  reason?: string;
}

export function submitGate(params: {
  /** The subject already has at least one supervisor. */
  hasSupervisor: boolean;
  /** The subject has an Employee record — without one they cannot be supervised. */
  isEmployee: boolean;
  /** The subject holds TIME_APPROVE, so they can sign their own week. */
  canApproveOwnTime: boolean;
  /** How many people COULD be named as their supervisor. */
  eligibleSupervisorCount: number;
}): SubmitGate {
  // The ordinary case: a supervisor exists, the week has somewhere to go.
  if (params.hasSupervisor) return { allowed: true };

  // Supervision is modelled employee-to-employee (`employee_supervisors` joins
  // two Employee ids), so someone with no employee record cannot be assigned a
  // supervisor at all. Demanding one would be unsatisfiable: the request modal
  // would open, they would pick somebody, and the assignment would have nowhere
  // to be written. The fix is an admin creating their employee record, which is
  // not something the blocked worker can do.
  if (!params.isEmployee) return { allowed: true };

  // The top of the org chart has nobody above it. `approvalAuthority` already
  // permits self-approval exactly when no supervisor exists, so this exemption
  // and the authority rule agree — an OWNER blocked here could never submit at
  // all, and blocking them achieves nothing anyway since they would simply
  // approve their own week.
  if (params.canApproveOwnTime) return { allowed: true };

  // THE CATASTROPHIC CASE. You cannot demand somebody get a supervisor when the
  // organisation has nobody who could be one. Ship the block without this and
  // every worker is refused, the modal they are sent to is empty, and the whole
  // company loses the ability to record time with no way out from inside the
  // product. The intended rollout is employee records → grant Reviewer/Approver
  // → assign supervisors; this makes a wrong ORDER survivable, not correct.
  if (params.eligibleSupervisorCount === 0) return { allowed: true };

  return {
    allowed: false,
    code: "SUPERVISOR_REQUIRED",
    reason:
      "You need a supervisor before you can submit a timesheet. Ask someone who can approve time to add you.",
  };
}

/**
 * The gate against real data.
 *
 * `canApproveOwnTime` is passed in rather than re-derived: the caller already
 * holds the actor's effective permissions (work-role grants folded in), and
 * asking twice is how two answers to one question start disagreeing.
 *
 * Returns the candidate list alongside the decision because computing it is what
 * decides the last exemption — the modal that opens on a block needs exactly
 * this set, and re-querying it would be a second chance to disagree.
 */
export async function resolveSubmitGate(params: {
  orgId: string;
  subjectUserId: string;
  canApproveOwnTime: boolean;
}): Promise<SubmitGate & { eligible: SupervisorCandidate[] }> {
  const { orgId, subjectUserId } = params;

  try {
    const [employee, supervised] = await Promise.all([
      prisma.employee.findFirst({
        where: { orgId, userId: subjectUserId },
        select: { id: true },
      }),
      hasSupervisor(orgId, subjectUserId),
    ]);

    // `assignableSupervisors` loads every employee and every supervisor edge in
    // the org, and this runs on each time-tracking page load. Skip it whenever
    // an earlier exemption already decides the answer — which, once an org has
    // rolled supervisors out, is the overwhelmingly common case.
    //
    // This is ONLY an optimisation, never a second decision: when it skips, the
    // count passed below is 0, and `submitGate` returns allowed on one of its
    // first three branches regardless of the count. The pure function stays the
    // single place the rule is expressed.
    const mightBlock =
      !supervised && Boolean(employee) && !params.canApproveOwnTime;
    const eligible =
      mightBlock && employee
        ? await assignableSupervisors(orgId, employee.id)
        : [];

    return {
      ...submitGate({
        hasSupervisor: supervised,
        isEmployee: Boolean(employee),
        canApproveOwnTime: params.canApproveOwnTime,
        eligibleSupervisorCount: eligible.length,
      }),
      eligible,
    };
  } catch {
    // Fail OPEN — see the header. A database hiccup must not stop someone
    // recording the hours they worked; it only costs an unrouted week, which is
    // exactly what happened before this gate existed.
    return { allowed: true, eligible: [] };
  }
}
