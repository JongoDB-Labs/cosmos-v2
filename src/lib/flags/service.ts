import { Prisma, type $Enums } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { subjectKey, type FlagSubject } from "./subject";

/**
 * Raising, clearing and sweeping standing flags.
 *
 * The shape a rule is expected to follow is: work out every condition that is
 * true right now, raise one flag each, then SWEEP - clear the flags this rule
 * raised previously whose condition is no longer among them. A rule that only
 * ever raises produces a screen nobody trusts within a month, because the
 * alarms outlive the problems.
 */

export type RaiseFlagInput = FlagSubject & {
  orgId: string;
  /** Namespaced by the owning plugin, e.g. "finance.burn.over-fee". */
  rule: string;
  severity: $Enums.FlagSeverity;
  title: string;
  body?: string;
};

/**
 * Raise a flag, or update the one already standing for this rule and subject.
 *
 * Idempotent by the DATABASE, not by a prior read: the partial unique index on
 * open flags is what makes a rule safe to run on a timer, and two runners
 * racing cannot produce a duplicate. A read-then-write would both race and
 * mis-report.
 *
 * A DISMISSED flag is deliberately NOT revived. Somebody looked at this exact
 * condition and decided it did not matter; a rule re-raising it every night
 * would be arguing with them, and they cannot win an argument with a cron job.
 */
export async function raiseFlag(input: RaiseFlagInput) {
  const { orgId, rule, severity, title, body = "", ...subject } = input;

  const dismissed = await prisma.flag.findFirst({
    where: { orgId, rule, status: "DISMISSED", ...subjectWhere(subject) },
    select: { id: true },
  });
  if (dismissed) return null;

  const open = await prisma.flag.findFirst({
    where: { orgId, rule, status: "OPEN", ...subjectWhere(subject) },
    select: { id: true },
  });

  if (open) {
    // Severity and wording can move while the condition persists: 80% of fee
    // becoming 100% is the same flag getting worse, not a second flag.
    return prisma.flag.update({
      where: { id: open.id },
      data: { severity, title, body },
    });
  }

  return prisma.flag.create({
    data: {
      orgId,
      rule,
      severity,
      title,
      body,
      projectId: subject.projectId ?? null,
      userId: subject.userId ?? null,
      subjectType: subject.subjectType ?? null,
      subjectId: subject.subjectId ?? null,
    },
  });
}

/** Exact-match subject predicate; nulls must match nulls, not "any". */
function subjectWhere(s: FlagSubject): Prisma.FlagWhereInput {
  return {
    projectId: s.projectId ?? null,
    userId: s.userId ?? null,
    subjectType: s.subjectType ?? null,
    subjectId: s.subjectId ?? null,
  };
}

/** A person deciding this does not matter. Sticks, even if the rule fires again. */
export async function dismissFlag(orgId: string, id: string, byId: string) {
  const { count } = await prisma.flag.updateMany({
    where: { id, orgId, status: "OPEN" },
    data: { status: "DISMISSED", resolvedAt: new Date(), resolvedById: byId },
  });
  return count > 0;
}

/**
 * Clear every open flag for this rule EXCEPT the subjects still true.
 *
 * This is the half that keeps the list honest, and it is why `keep` is the
 * surviving set rather than a list to remove: a rule knows what is wrong now,
 * not what stopped being wrong since it last ran. Expressing it the other way
 * round would need the rule to remember its own history.
 *
 * Resolved, never deleted. "This was true in March and is not now" is worth
 * keeping; a flag that vanishes leaves nobody able to ask whether it recurred.
 */
export async function sweepRule(orgId: string, rule: string, keep: FlagSubject[]) {
  const open = await prisma.flag.findMany({
    where: { orgId, rule, status: "OPEN" },
    select: { id: true, projectId: true, userId: true, subjectType: true, subjectId: true },
  });
  const live = new Set(keep.map((s) => subjectKey(rule, s)));
  const stale = open.filter((f) => !live.has(subjectKey(rule, f))).map((f) => f.id);
  if (stale.length === 0) return 0;

  const { count } = await prisma.flag.updateMany({
    where: { id: { in: stale } },
    // No resolvedById: nobody resolved it, the condition stopped being true.
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  return count;
}

/** What is wrong right now, worst first. */
export async function openFlags(orgId: string, opts: { projectId?: string } = {}) {
  return prisma.flag.findMany({
    where: { orgId, status: "OPEN", ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    orderBy: [{ severity: "desc" }, { raisedAt: "desc" }],
  });
}
