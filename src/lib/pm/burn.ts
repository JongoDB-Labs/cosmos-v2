import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { sumMoney, roundMoney, moneyToNumber } from "@/lib/money";
import { laborCostFor } from "@/lib/payroll/labor";

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

/** Float rounding, retained ONLY for PROJECTIONS — run rate, EAC and the
 *  forecast line. Those are estimates, not recorded money. Every actual
 *  (labour, expense, burned, the cumulative series) goes through lib/money so
 *  it agrees with payroll to the cent. */
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
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED", ...NOT_VOIDED },
      select: { clinId: true, hours: true, rate: true, userId: true },
    }),
    prisma.expense.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED", ...NOT_VOIDED },
      select: { clinId: true, amount: true },
    }),
    prisma.employee.findMany({ where: { orgId }, select: { userId: true, costRate: true } }),
  ]);

  // Decimals kept as Decimals. Converting to `number` here and multiplying in
  // floating point is what made this figure disagree with payroll, which
  // computes the SAME labour from the SAME hours via lib/money.
  const rateByUser = new Map(employees.map((e) => [e.userId, e.costRate]));

  const laborByClin = new Map<string, Prisma.Decimal[]>();
  for (const t of timeEntries) {
    if (!t.clinId) continue;
    const rate = t.rate ?? rateByUser.get(t.userId) ?? new Prisma.Decimal(0);
    // `laborCostFor` is the shared definition of "labour cost for these hours
    // at this rate" — half-even to cents, per line, exactly as a pay run and an
    // invoice line do it. Sharing the function is what keeps the two agreeing.
    const line = laborCostFor(t.hours, rate);
    const acc = laborByClin.get(t.clinId);
    if (acc) acc.push(line);
    else laborByClin.set(t.clinId, [line]);
  }
  const expenseByClin = new Map<string, Prisma.Decimal[]>();
  for (const e of expenses) {
    if (!e.clinId) continue;
    const acc = expenseByClin.get(e.clinId);
    if (acc) acc.push(e.amount);
    else expenseByClin.set(e.clinId, [e.amount]);
  }

  return clins.map((c): ClinBurn => {
    const value = Number(c.value);
    const laborDec = roundMoney(sumMoney(laborByClin.get(c.id) ?? []));
    const expenseDec = roundMoney(sumMoney(expenseByClin.get(c.id) ?? []));
    // Number only at the boundary — ClinBurn is a DTO of plain numbers, but
    // every arithmetic step above it stayed exact.
    const laborCost = moneyToNumber(laborDec);
    const expenseCost = moneyToNumber(expenseDec);
    const burned = moneyToNumber(roundMoney(laborDec.plus(expenseDec)));
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
  // Contract values, not estimates: summed in Decimal. `fundedValue` is what
  // you are actually permitted to bill against, so it has to be exact.
  const ceiling = moneyToNumber(roundMoney(sumMoney(clins.map((c) => c.value))));
  const funded = moneyToNumber(roundMoney(sumMoney(clins.map((c) => c.fundedValue))));
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
  const rateByUser = new Map(employees.map((e) => [e.userId, e.costRate]));

  // Same rule as clinBurn and payroll: Decimal per line, half-even to cents.
  // The monthly curve has to add up to the same total the CLIN roll-up shows.
  const actualByMonth = new Map<string, Prisma.Decimal[]>();
  const note = (key: string, amt: Prisma.Decimal) => {
    const acc = actualByMonth.get(key);
    if (acc) acc.push(amt);
    else actualByMonth.set(key, [amt]);
  };
  for (const t of timeEntries) {
    const rate = t.rate ?? rateByUser.get(t.userId) ?? new Prisma.Decimal(0);
    note(mKey(t.date), laborCostFor(t.hours, rate));
  }
  for (const e of expenses) note(mKey(e.date), e.amount);

  const burnedToDate = moneyToNumber(
    roundMoney(sumMoney([...actualByMonth.values()].flat())),
  );
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
  // The cumulative line accumulates in Decimal and is only rendered as a
  // number, so the last point equals burnedToDate exactly rather than drifting
  // away from it month by month.
  let cumDec = new Prisma.Decimal(0);
  for (let k = startKey, guard = 0; guard < 360; k = mAdd(k, 1), guard++) {
    const isPast = mDiff(k, nowKey) >= 0; // k ≤ now
    if (isPast) {
      cumDec = roundMoney(cumDec.plus(sumMoney(actualByMonth.get(k) ?? [])));
    }
    const cum = moneyToNumber(cumDec);
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
