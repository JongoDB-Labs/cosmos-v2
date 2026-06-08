import { Prisma } from "@prisma/client";
import { multiplyMoney, roundMoney, sumMoney } from "@/lib/money";

/** Labor cost = hours × hourly cost rate, half-even to cents. */
export function laborCostFor(hours: number, costRate: Prisma.Decimal): Prisma.Decimal {
  return roundMoney(multiplyMoney(costRate, hours));
}

export type LaborEntry = {
  userId: string;
  projectId: string | null;
  hours: number;
};

export type LaborProjectGroup = {
  projectId: string | null;
  /**
   * Human-readable project name. `summarizeLabor` is pure and has no DB access,
   * so it leaves this null; callers with DB access (e.g. previewPayRun) backfill
   * it so the UI never has to render a raw UUID.
   */
  projectName: string | null;
  cost: string;
};

export type LaborSummary = {
  byProject: LaborProjectGroup[];
  total: string;
  /** Entries that had an employee cost rate (and were costed). */
  priced: number;
  /** Entries whose user has no active Employee / cost rate — skipped. */
  unpriced: number;
};

/**
 * PURE. Cost each entry at its employee's hourly cost rate and group by project.
 * Entries whose `userId` is absent from `costRateByUser` are skipped and counted in
 * `unpriced` (so the caller can surface "N entries have no pay rate"). The `null`
 * project bucket carries unassigned labor.
 */
export function summarizeLabor(
  entries: LaborEntry[],
  costRateByUser: Map<string, Prisma.Decimal>,
): LaborSummary {
  const byProject = new Map<string, Prisma.Decimal>(); // "" = no project
  let priced = 0;
  let unpriced = 0;
  for (const e of entries) {
    const rate = costRateByUser.get(e.userId);
    if (!rate) {
      unpriced++;
      continue;
    }
    priced++;
    const cost = laborCostFor(e.hours, rate);
    const key = e.projectId ?? "";
    byProject.set(key, (byProject.get(key) ?? new Prisma.Decimal(0)).plus(cost));
  }
  const groups: LaborProjectGroup[] = [...byProject.entries()].map(([k, v]) => ({
    projectId: k === "" ? null : k,
    projectName: null,
    cost: v.toString(),
  }));
  const total = sumMoney([...byProject.values()]);
  return { byProject: groups, total: total.toString(), priced, unpriced };
}
