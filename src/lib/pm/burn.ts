import { prisma } from "@/lib/db/client";

/**
 * CLIN burn — attribute approved time + expenses to a CLIN and roll up actuals
 * vs the funded value / ceiling. Labor cost = hours × (entry rate ∥ the
 * person's Employee cost rate). Computed on read; never persisted.
 */
export interface ClinBurn {
  id: string;
  code: string;
  title: string;
  value: number; // ceiling
  fundedValue: number;
  popStart: string | null;
  popEnd: string | null;
  status: string;
  laborCost: number;
  expenseCost: number;
  burned: number; // labor + expense
  remaining: number; // value − burned
  percentConsumed: number | null; // burned / value
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadClinsWithBurn(
  orgId: string,
  projectId?: string,
): Promise<ClinBurn[]> {
  const clins = await prisma.clin.findMany({
    where: projectId ? { orgId, projectId } : { orgId },
    orderBy: { code: "asc" },
  });
  const clinIds = clins.map((c) => c.id);
  if (clinIds.length === 0) return [];

  const [timeEntries, expenses, employees] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { clinId: true, hours: true, rate: true, userId: true },
    }),
    prisma.expense.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { clinId: true, amount: true },
    }),
    prisma.employee.findMany({ where: { orgId }, select: { userId: true, costRate: true } }),
  ]);

  const rateByUser = new Map(employees.map((e) => [e.userId, Number(e.costRate)]));

  const laborByClin = new Map<string, number>();
  for (const t of timeEntries) {
    if (!t.clinId) continue;
    const rate = t.rate != null ? Number(t.rate) : (rateByUser.get(t.userId) ?? 0);
    laborByClin.set(t.clinId, (laborByClin.get(t.clinId) ?? 0) + t.hours * rate);
  }
  const expenseByClin = new Map<string, number>();
  for (const e of expenses) {
    if (!e.clinId) continue;
    expenseByClin.set(e.clinId, (expenseByClin.get(e.clinId) ?? 0) + Number(e.amount));
  }

  return clins.map((c): ClinBurn => {
    const value = Number(c.value);
    const laborCost = round2(laborByClin.get(c.id) ?? 0);
    const expenseCost = round2(expenseByClin.get(c.id) ?? 0);
    const burned = round2(laborCost + expenseCost);
    return {
      id: c.id,
      code: c.code,
      title: c.title,
      value,
      fundedValue: Number(c.fundedValue),
      popStart: c.popStart ? c.popStart.toISOString() : null,
      popEnd: c.popEnd ? c.popEnd.toISOString() : null,
      status: c.status,
      laborCost,
      expenseCost,
      burned,
      remaining: round2(value - burned),
      percentConsumed: value > 0 ? Math.round((burned / value) * 100) : null,
    };
  });
}
