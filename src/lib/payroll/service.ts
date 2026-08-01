// SCOPING NOTE — deliberately NOT narrowed by teamScopedAccess.
//
// Payroll rollups are an administrative surface whose whole purpose is a
// complete picture of cost across the org; an incomplete one is the worse
// failure, and reaching it already requires org-level payroll permissions.
//
// Revisit if teamScopedAccess is ever promoted from a visibility default to a
// hard boundary.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ConflictError, NotFoundError } from "@/lib/rbac/check";
import { postEntry, type PostingLine } from "@/lib/ledger/posting";
import { ACCOUNT_CODES, resolveAccount } from "@/lib/ledger/chart-of-accounts";
import { laborCostFor, summarizeLabor, type LaborSummary } from "./labor";
import { NOT_VOIDED } from "@/lib/time/not-voided";

// ── Employees ────────────────────────────────────────────────────────────────

export type EmployeeInput = {
  userId: string;
  employmentType?: "SALARY" | "HOURLY";
  costRate: number | string;
  laborCategory?: string | null;
  classification?: string | null;
  status?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  /** Supervisor, as an Employee id. Null clears it. */
};

export function listEmployees(orgId: string) {
  return prisma.employee.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function createEmployee(
  orgId: string,
  createdById: string,
  input: EmployeeInput,
) {
  const member = await prisma.orgMember.findFirst({
    where: { orgId, userId: input.userId },
    select: { id: true },
  });
  if (!member) throw new NotFoundError("User is not a member of this org");
  return prisma.employee.create({
    data: {
      orgId,
      createdById,
      userId: input.userId,
      employmentType: input.employmentType ?? "HOURLY",
      costRate: new Prisma.Decimal(input.costRate),
      laborCategory: input.laborCategory ?? null,
      classification: input.classification ?? null,
      status: input.status ?? "active",
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
    },
  });
}

/**
 * The cost rate a bulk-created employee starts on.
 *
 * `costRate` is NOT NULL, so a bulk create has to put SOMETHING there, and the
 * only honest value is zero. Guessing a rate — an org average, the last one
 * entered — would silently mis-state labor expense, CLIN burn and every posted
 * pay run, and nothing downstream would flag it because the number looks
 * plausible. A zero is obviously unset: `postPayRun` costs it to nothing and
 * reports it, and the payroll table shows $0.00 in a column an admin reads.
 */
const UNSET_COST_RATE = new Prisma.Decimal(0);

export type BulkEmployeeResult = {
  /** User ids that gained an employee record on THIS call. */
  createdUserIds: string[];
  /** User ids that already had one. Re-running is a no-op over these. */
  skippedUserIds: string[];
};

/**
 * Give a batch of org members employee records in one go.
 *
 * Supervision, timesheet approval and labor costing all hang off `Employee`, so
 * an org with members but no employee records has an inert approval chain and
 * no way to fix it except adding people one at a time. This is the way out of
 * that hole.
 *
 * Two properties matter and neither is incidental:
 *
 *   - **All-or-nothing on membership.** Every id must already be an OrgMember of
 *     this org. A batch containing an outsider is rejected whole rather than
 *     partly applied, because a caller cannot tell which half of a partial
 *     application landed, and a stray employee record in the wrong tenant is
 *     exactly the kind of thing nobody notices until payroll runs.
 *   - **Idempotent by the DATABASE, not by a prior read.** `ON CONFLICT DO
 *     NOTHING RETURNING` (`createManyAndReturn` + `skipDuplicates`) leans on the
 *     `[orgId, userId]` unique index, so two admins clicking at once cannot
 *     produce a duplicate — and the rows it returns are the ones this call
 *     actually inserted, which is what the audit record needs. A read-then-write
 *     would both race and mis-report.
 */
export async function createEmployeesForMembers(
  orgId: string,
  createdById: string,
  userIds: string[],
): Promise<BulkEmployeeResult> {
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return { createdUserIds: [], skippedUserIds: [] };

  const members = await prisma.orgMember.findMany({
    where: { orgId, userId: { in: wanted } },
    select: { userId: true },
  });
  const isMember = new Set(members.map((m) => m.userId));
  const strangers = wanted.filter((id) => !isMember.has(id));
  if (strangers.length > 0) {
    // Same failure, same shape as the single-employee create above — one
    // condition should not answer differently depending on which route reached
    // it. The count is named because the caller sent a list and needs to know
    // it was the list, not the org, that was wrong.
    throw new NotFoundError(
      strangers.length === 1
        ? "One of those people is not a member of this org"
        : `${strangers.length} of those people are not members of this org`,
    );
  }

  const created = await prisma.employee.createManyAndReturn({
    data: wanted.map((userId) => ({
      orgId,
      userId,
      createdById,
      costRate: UNSET_COST_RATE,
    })),
    skipDuplicates: true,
    select: { userId: true },
  });

  const createdUserIds = created.map((e) => e.userId);
  const madeNew = new Set(createdUserIds);
  return {
    createdUserIds,
    skippedUserIds: wanted.filter((id) => !madeNew.has(id)),
  };
}

export async function updateEmployee(
  orgId: string,
  employeeId: string,
  input: Partial<Omit<EmployeeInput, "userId">>,
) {
  // Supervisors are NOT settable here. They live in `employee_supervisors`,
  // written through lib/org/supervisors — ONE write path, so the org chart and
  // the approval check cannot disagree about who approves whom.
  const data: Prisma.EmployeeUncheckedUpdateManyInput = {};
  if (input.employmentType !== undefined) data.employmentType = input.employmentType;
  if (input.costRate !== undefined) data.costRate = new Prisma.Decimal(input.costRate);
  if (input.laborCategory !== undefined) data.laborCategory = input.laborCategory;
  if (input.classification !== undefined) data.classification = input.classification;
  if (input.status !== undefined) data.status = input.status;
  if (input.startDate !== undefined) data.startDate = input.startDate;
  if (input.endDate !== undefined) data.endDate = input.endDate;

  const updated = await prisma.employee.updateMany({
    where: { id: employeeId, orgId },
    data,
  });
  if (updated.count === 0) throw new NotFoundError("Employee not found");
  return prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
}

// ── Pay runs ─────────────────────────────────────────────────────────────────

export function listPayRuns(orgId: string) {
  return prisma.payRun.findMany({ where: { orgId }, orderBy: { periodStart: "desc" } });
}

export function createPayRun(
  orgId: string,
  createdById: string,
  input: { label?: string; periodStart: Date; periodEnd: Date },
) {
  if (input.periodEnd < input.periodStart) {
    throw new ConflictError("Period end is before period start");
  }
  return prisma.payRun.create({
    data: {
      orgId,
      createdById,
      label: input.label ?? "",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
  });
}

/** Approved, not-yet-distributed time entries in the run's period. */
async function gatherUndistributed(orgId: string, periodStart: Date, periodEnd: Date) {
  return prisma.timeEntry.findMany({
    where: {
      orgId,
      status: "APPROVED",
      payRunId: null,
      date: { gte: periodStart, lte: periodEnd },
      ...NOT_VOIDED,
    },
    select: { id: true, userId: true, projectId: true, hours: true },
  });
}

async function costRateByUser(orgId: string, userIds: string[]) {
  const emps = await prisma.employee.findMany({
    where: { orgId, userId: { in: userIds }, status: "active" },
    select: { userId: true, costRate: true },
  });
  return new Map(emps.map((e) => [e.userId, e.costRate]));
}

export async function previewPayRun(orgId: string, payRunId: string): Promise<LaborSummary> {
  const run = await prisma.payRun.findFirst({ where: { id: payRunId, orgId } });
  if (!run) throw new NotFoundError("Pay run not found");
  const entries = await gatherUndistributed(orgId, run.periodStart, run.periodEnd);
  const rates = await costRateByUser(orgId, [...new Set(entries.map((e) => e.userId))]);
  const summary = summarizeLabor(entries, rates);

  // Backfill project names so the preview UI never renders a raw UUID.
  const projectIds = summary.byProject
    .map((g) => g.projectId)
    .filter((id): id is string => id !== null);
  if (projectIds.length) {
    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    summary.byProject = summary.byProject.map((g) => ({
      ...g,
      projectName: g.projectId ? (nameById.get(g.projectId) ?? null) : null,
    }));
  }
  return summary;
}

/**
 * Post the labor distribution: one balanced journal entry — a Dr Labor Expense line
 * per project (tagged with projectId for the DCAA dimension) + a Cr Accrued Payroll
 * line for the total — then mark the costed entries with the run id. Idempotent on
 * (source PAYROLL, payRunId). Throws if there's no priced approved labor.
 */
export type PostPayRunResult = {
  payRun: Prisma.PayRunGetPayload<object>;
  unpricedSkipped: number;
};

async function finalizeRun(payRunId: string, laborCost: Prisma.Decimal, postedAt: Date) {
  return prisma.payRun.update({
    where: { id: payRunId },
    data: { status: "POSTED", laborCost, postedAt },
  });
}

export async function postPayRun(
  orgId: string,
  payRunId: string,
  createdById: string,
): Promise<PostPayRunResult> {
  const run = await prisma.payRun.findFirst({ where: { id: payRunId, orgId } });
  if (!run) throw new NotFoundError("Pay run not found");
  if (run.status === "POSTED") throw new ConflictError("Pay run already posted");

  // Recovery: if a prior attempt posted the GL entry but failed before marking the
  // run POSTED, finalize from the existing entry rather than posting a second time.
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId, source: "PAYROLL", sourceId: payRunId, status: "POSTED" },
    include: { lines: { where: { direction: "DEBIT" }, select: { amount: true } } },
  });
  if (existing) {
    const total = existing.lines.reduce((a, l) => a.plus(l.amount), new Prisma.Decimal(0));
    return { payRun: await finalizeRun(payRunId, total, existing.postedAt ?? new Date()), unpricedSkipped: 0 };
  }

  // Candidates: approved + un-distributed labor in the period.
  const candidates = await gatherUndistributed(orgId, run.periodStart, run.periodEnd);
  const rates = await costRateByUser(orgId, [...new Set(candidates.map((e) => e.userId))]);
  const pricedIds = candidates.filter((e) => rates.has(e.userId)).map((e) => e.id);
  const unpricedSkipped = candidates.length - pricedIds.length;
  if (pricedIds.length === 0) {
    throw new ConflictError("No priced, approved labor to distribute in this period");
  }

  // CLAIM the priced entries FIRST (atomic): only entries still un-assigned become
  // this run's. A concurrent run that grabbed some leaves them out of `claimed`, so
  // the GL total below derives ONLY from rows this run owns — no cross-run double-post.
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.timeEntry.updateMany({
      where: { id: { in: pricedIds }, orgId, payRunId: null },
      data: { payRunId },
    });
    return tx.timeEntry.findMany({
      where: { id: { in: pricedIds }, orgId, payRunId },
      select: { id: true, userId: true, projectId: true, hours: true },
    });
  });
  if (claimed.length === 0) {
    throw new ConflictError("This labor was already claimed by another pay run");
  }

  try {
    // Cost the CLAIMED entries, group by project, drop zero buckets (a 0 line would
    // fail assertBalanced); the credit total is the sum of the surviving debits.
    const byProject = new Map<string, Prisma.Decimal>();
    for (const e of claimed) {
      const cost = laborCostFor(e.hours, rates.get(e.userId)!);
      byProject.set(e.projectId ?? "", (byProject.get(e.projectId ?? "") ?? new Prisma.Decimal(0)).plus(cost));
    }
    const debits = [...byProject.entries()].filter(([, cost]) => cost.greaterThan(0));
    const total = debits.reduce((a, [, cost]) => a.plus(cost), new Prisma.Decimal(0));

    if (!total.greaterThan(0)) {
      // Everything claimed costed to 0 (zero rates) — nothing to post; finalize at 0
      // so the (now-claimed) entries don't wedge the run.
      return { payRun: await finalizeRun(payRunId, new Prisma.Decimal(0), new Date()), unpricedSkipped };
    }

    const [laborExpense, accruedPayroll] = await Promise.all([
      resolveAccount(orgId, ACCOUNT_CODES.LABOR_EXPENSE),
      resolveAccount(orgId, ACCOUNT_CODES.ACCRUED_PAYROLL),
    ]);
    const lines: PostingLine[] = debits.map(([projectKey, cost]) => ({
      accountId: laborExpense,
      direction: "DEBIT",
      amount: cost,
      projectId: projectKey === "" ? null : projectKey,
    }));
    lines.push({ accountId: accruedPayroll, direction: "CREDIT", amount: total });

    await postEntry({
      orgId,
      createdById,
      date: run.periodEnd,
      source: "PAYROLL",
      sourceId: payRunId,
      memo: `Payroll ${run.label || `${run.periodStart.toISOString().slice(0, 10)}–${run.periodEnd.toISOString().slice(0, 10)}`}`,
      lines,
    });

    return { payRun: await finalizeRun(payRunId, total, new Date()), unpricedSkipped };
  } catch (err) {
    // The GL post (or finalize) failed AFTER claiming. If no entry was posted, release
    // the claim so a retry can re-gather; if an entry exists, leave the claim (the
    // recovery path above will finalize on retry).
    const posted = await prisma.journalEntry.findFirst({
      where: { orgId, source: "PAYROLL", sourceId: payRunId, status: "POSTED" },
      select: { id: true },
    });
    if (!posted) {
      await prisma.timeEntry.updateMany({
        where: { id: { in: claimed.map((e) => e.id) }, orgId, payRunId },
        data: { payRunId: null },
      });
    }
    throw err;
  }
}

/** Posted labor cost grouped by project (from POSTED payroll journal lines). */
export async function laborByProject(orgId: string) {
  const lines = await prisma.journalLine.findMany({
    where: { orgId, direction: "DEBIT", entry: { source: "PAYROLL", status: "POSTED" } },
    select: { projectId: true, amount: true },
  });
  const byProject = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    const key = l.projectId ?? "";
    byProject.set(key, (byProject.get(key) ?? new Prisma.Decimal(0)).plus(l.amount));
  }

  // Resolve project names so the UI never has to fall back to a raw UUID.
  const projectIds = [...byProject.keys()].filter((k) => k !== "");
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  return [...byProject.entries()].map(([k, v]) => ({
    projectId: k === "" ? null : k,
    projectName: k === "" ? null : (nameById.get(k) ?? null),
    cost: v.toString(),
  }));
}
