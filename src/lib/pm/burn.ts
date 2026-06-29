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

// ── Time-phased EVM ─────────────────────────────────────────────────────────
// Bri's "Financial / Burn" view: cumulative Actual vs Forecast vs Ceiling/Funded
// over the period of performance, plus an EAC (estimate at completion) projected
// from the current burn rate. All derived on read from the same approved
// time + expense actuals — never persisted.

export interface ClinBurnSeriesPoint {
  month: string; // "2026-02"
  label: string; // "Feb '26"
  cumActual: number | null; // cumulative burn through this month (null in the future)
  cumForecast: number | null; // run-rate projection from now → PoP end (null before now)
  ceiling: number;
  funded: number;
}

export interface ClinBurnTimePhased {
  ceiling: number;
  funded: number;
  burnedToDate: number;
  eac: number; // estimate at completion (burn-rate projection)
  eacVsCeiling: number; // eac − ceiling (positive = projected over ceiling)
  percentFunded: number | null; // burned / funded
  monthlyRunRate: number;
  popStart: string | null;
  popEnd: string | null;
  series: ClinBurnSeriesPoint[];
}

const mKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const mLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" })} '${String(y).slice(2)}`;
};
const mAdd = (key: string, n: number) => {
  const [y, m] = key.split("-").map(Number);
  return mKey(new Date(y, m - 1 + n, 1));
};
/** Signed count of month-steps from a → b (b − a). */
const mDiff = (a: string, b: string) => {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};

export async function loadClinBurnTimePhased(
  orgId: string,
  projectId?: string,
): Promise<ClinBurnTimePhased> {
  const clins = await prisma.clin.findMany({
    where: projectId ? { orgId, projectId } : { orgId },
    select: { id: true, value: true, fundedValue: true, popStart: true, popEnd: true },
  });
  const ceiling = round2(clins.reduce((s, c) => s + Number(c.value), 0));
  const funded = round2(clins.reduce((s, c) => s + Number(c.fundedValue), 0));
  const base: ClinBurnTimePhased = {
    ceiling, funded, burnedToDate: 0, eac: 0, eacVsCeiling: round2(-ceiling),
    percentFunded: null, monthlyRunRate: 0, popStart: null, popEnd: null, series: [],
  };
  const clinIds = clins.map((c) => c.id);
  if (clinIds.length === 0) return base;

  const [timeEntries, expenses, employees] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { date: true, hours: true, rate: true, userId: true },
    }),
    prisma.expense.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { date: true, amount: true },
    }),
    prisma.employee.findMany({ where: { orgId }, select: { userId: true, costRate: true } }),
  ]);
  const rateByUser = new Map(employees.map((e) => [e.userId, Number(e.costRate)]));

  const actualByMonth = new Map<string, number>();
  const note = (key: string, amt: number) => {
    actualByMonth.set(key, (actualByMonth.get(key) ?? 0) + amt);
  };
  for (const t of timeEntries) {
    const rate = t.rate != null ? Number(t.rate) : (rateByUser.get(t.userId) ?? 0);
    note(mKey(t.date), t.hours * rate);
  }
  for (const e of expenses) note(mKey(e.date), Number(e.amount));

  const burnedToDate = round2([...actualByMonth.values()].reduce((s, v) => s + v, 0));
  const earliest = actualByMonth.size ? [...actualByMonth.keys()].sort()[0] : null;

  const starts = clins.map((c) => c.popStart).filter((d): d is Date => !!d);
  const ends = clins.map((c) => c.popEnd).filter((d): d is Date => !!d);
  const popStart = starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null;
  const popEnd = ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;

  const now = new Date();
  const nowKey = mKey(now);
  let startKey = popStart ? mKey(popStart) : (earliest ?? nowKey);
  if (earliest && earliest < startKey) startKey = earliest;
  let endKey = popEnd ? mKey(popEnd) : mAdd(nowKey, 6);
  if (mDiff(nowKey, endKey) < 0) endKey = nowKey; // PoP already ended

  const monthsElapsed = Math.max(1, mDiff(startKey, nowKey) + 1);
  const monthsRemaining = Math.max(0, mDiff(nowKey, endKey));
  const runRate = round2(burnedToDate / monthsElapsed);
  const eac = round2(burnedToDate + runRate * monthsRemaining);

  const series: ClinBurnSeriesPoint[] = [];
  let cum = 0;
  for (let k = startKey, guard = 0; guard < 360; k = mAdd(k, 1), guard++) {
    const isPast = mDiff(k, nowKey) >= 0; // k ≤ now
    if (isPast) cum = round2(cum + (actualByMonth.get(k) ?? 0));
    series.push({
      month: k, label: mLabel(k),
      cumActual: isPast ? cum : null,
      cumForecast: null,
      ceiling, funded,
    });
    if (k === endKey) break;
  }
  // Forecast line: anchor at "now" (= burnedToDate) and extend at the run rate.
  let fc = burnedToDate;
  let anchored = false;
  for (const p of series) {
    if (p.month === nowKey) { p.cumForecast = round2(burnedToDate); anchored = true; continue; }
    if (anchored) { fc = round2(fc + runRate); p.cumForecast = fc; }
  }

  return {
    ceiling, funded, burnedToDate, eac,
    eacVsCeiling: round2(eac - ceiling),
    percentFunded: funded > 0 ? Math.round((burnedToDate / funded) * 100) : null,
    monthlyRunRate: runRate,
    popStart: popStart ? popStart.toISOString() : null,
    popEnd: popEnd ? popEnd.toISOString() : null,
    series,
  };
}
