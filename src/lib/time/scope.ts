import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { canReadAllTime } from "./visibility";

/**
 * Which users' time entries may this actor read?
 *
 * `null` means "no restriction" (TIME_READ_ALL). Otherwise it is the actor
 * plus their DIRECT REPORTS — the supervisor read path.
 *
 * ── Why this is not an ABAC rule ────────────────────────────────────────────
 * `abac/engine.ts:8` is explicit: rules can only NARROW, and v1 supports DENY
 * only — the decision is `RBAC-baseline AND NOT(any firing deny)`, and an
 * `allow` rule is INERT. `work-role.ts:58` then refuses to author a policy
 * naming `is_manager_of_assignee` at all. So the engine's manager predicate
 * cannot GRANT a supervisor anything; it exists to take approval authority
 * away. Letting a supervisor SEE their reports' time is a widening, and a
 * widening belongs here, in the route's scope computation.
 *
 * ── Direct reports only ─────────────────────────────────────────────────────
 * One hop down the chart, deliberately. Skip-level visibility is a policy
 * question nobody has asked for; a manager two levels up who genuinely needs it
 * gets TIME_READ_ALL. Since an employee may have SEVERAL supervisors, "my
 * reports" is every employee with an edge to me — not a single-parent walk.
 *
 * Supervisors still do not see RATES — that stays `canSeeRate` (own row, or
 * FINANCE_READ). Confirming someone's hours does not require seeing their pay.
 */
export async function readableTimeUserIds(
  ctx: AuthContext,
): Promise<string[] | null> {
  if (canReadAllTime(ctx)) return null;

  try {
    const [rows, routed] = await Promise.all([
      // The actor's own employee row (if any) OR any employee one of whose
      // supervisors is the actor. Both sides are scoped to the org — the FKs
      // alone do not constrain a row to the same tenant.
      prisma.employee.findMany({
        where: {
          orgId: ctx.orgId,
          OR: [
            { userId: ctx.userId },
            {
              supervisors: {
                some: {
                  orgId: ctx.orgId,
                  supervisor: { orgId: ctx.orgId, userId: ctx.userId },
                },
              },
            },
          ],
        },
        select: { userId: true },
      }),
      // Plus anyone whose week is CURRENTLY WAITING ON THIS ACTOR.
      //
      // Being routed a timesheet and being able to open it were separate
      // things: an approver who is not the person's supervisor — the pool
      // case — was notified about a week and then met an empty page, because
      // reads were scoped to self-and-reports only. The notification even
      // deep-links to that week.
      //
      // Deliberately bounded to sheets awaiting a decision. Once approved or
      // returned the widening LAPSES: it exists because they owe an answer,
      // not as a permanent grant over that person's time. Anyone who needs
      // standing visibility has TIME_READ_ALL.
      prisma.timesheet.findMany({
        where: {
          orgId: ctx.orgId,
          approverIds: { has: ctx.userId },
          status: { in: ["SUBMITTED", "LABOR_APPROVED"] },
        },
        select: { userId: true },
      }),
    ]);
    // ctx.userId is added unconditionally: an actor with no Employee row at all
    // still reads their own time.
    return [
      ...new Set([
        ctx.userId,
        ...rows.map((r) => r.userId),
        ...routed.map((r) => r.userId),
      ]),
    ];
  } catch {
    // Fail NARROW, never open. A lookup failure must not widen the scope to
    // the org — own entries only is the safe answer.
    return [ctx.userId];
  }
}

/**
 * Prisma `userId` filter for a set resolved above, or `undefined` for no
 * filter. Shared so the list and single-entry routes cannot drift apart.
 */
export function timeUserIdFilter(
  allowed: string[] | null,
): { in: string[] } | undefined {
  return allowed ? { in: allowed } : undefined;
}

export type TimePerson = {
  userId: string;
  displayName: string | null;
  /** True for the signed-in actor. Explicit rather than "the first one", so the
   *  client never has to infer identity from sort order. */
  isSelf: boolean;
};

/**
 * WHOSE time this actor may look at, with names — the selectable set behind the
 * time-tracking page's person picker.
 *
 * This exists because widening the read scope breaks the page's arithmetic.
 * The week grid sums every row it is handed (`getDayTotal` / `weekTotal`), so
 * the moment one response carries more than one person's entries, "your week
 * total" silently becomes several people's hours added together. That was
 * already true for admins reading org-wide; supervisors would have inherited
 * it.
 *
 * The fix is to view ONE person at a time, so this answers "who may I pick".
 * A single-element result means there is no picker worth rendering.
 */
export async function readableTimePeople(
  ctx: AuthContext,
): Promise<TimePerson[]> {
  const allowed = await readableTimeUserIds(ctx);

  // null (TIME_READ_ALL) → everyone in the org, which is the same set the
  // members page already lists. Otherwise → self + direct reports.
  const members = await prisma.orgMember.findMany({
    where: {
      orgId: ctx.orgId,
      ...(allowed ? { userId: { in: allowed } } : {}),
    },
    select: { userId: true, user: { select: { displayName: true } } },
  });

  const people = members.map((m) => ({
    userId: m.userId,
    displayName: m.user?.displayName ?? null,
    isSelf: m.userId === ctx.userId,
  }));

  // The actor sorts first: the page defaults to "my time", and a picker whose
  // first option is somebody else invites picking the wrong one.
  people.sort((a, b) => {
    if (a.userId === ctx.userId) return -1;
    if (b.userId === ctx.userId) return 1;
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });
  return people;
}
