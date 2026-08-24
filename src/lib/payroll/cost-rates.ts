import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Where an employee's rate history starts.
 *
 * A first rate is floored rather than dated at the person's start date, so an
 * hour backdated before they were onboarded still resolves to a rate instead of
 * silently dropping out of every cost total. It also matches what the single
 * `employees.cost_rate` column always meant: this rate, for all of time. Real
 * dates begin with the SECOND row.
 */
export const RATE_FLOOR = new Date("1970-01-01T00:00:00.000Z");

/** Today as a UTC date-only value, to match the DATE columns it is compared to. */
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type CostRateAt = {
  effectiveFrom: Date;
  costRate: Prisma.Decimal;
};

/** userId → that person's cost rates, NEWEST FIRST. */
export type CostRateHistory = Map<string, CostRateAt[]>;

/**
 * PURE. What this person's hour cost on `on`: the most recent rate that had
 * taken effect by that date.
 *
 * Undefined has one meaning — "no rate applies" — and two causes: the person has
 * no rate at all, or none had taken effect yet on that date. Callers count both
 * as unpriced. Falling back to the earliest known rate would be the tempting
 * thing and the wrong one: it invents a cost for an hour nobody had priced, and
 * hides it inside a total that looks complete.
 *
 * `effectiveFrom` and `TimeEntry.date` are both DATE columns, so both arrive as
 * UTC midnight and compare without a timezone hazard. The boundary is inclusive:
 * a rate effective the 1st prices the 1st.
 */
export function resolveCostRate(
  history: CostRateHistory,
  userId: string,
  on: Date,
): Prisma.Decimal | undefined {
  const rates = history.get(userId);
  if (!rates) return undefined;
  const at = on.getTime();
  // Newest first, so the first row that has taken effect is the one in force.
  return rates.find((r) => r.effectiveFrom.getTime() <= at)?.costRate;
}

/**
 * Load rate history for these users.
 *
 * By default only ACTIVE employees, which is what payroll wants: a pay run pays
 * the people currently employed. Historical reporting wants the opposite — a
 * project finished last year was costed by whoever worked on it, and dropping
 * someone because they have since left makes that work retrospectively free and
 * the margin on it wrong. Those callers pass `includeFormerEmployees`.
 *
 * The default preserves the behaviour of the single-column lookup this replaced,
 * so no existing caller changes by upgrading.
 */
export async function loadCostRateHistory(
  orgId: string,
  userIds: string[],
  opts?: { includeFormerEmployees?: boolean },
): Promise<CostRateHistory> {
  const employees = await prisma.employee.findMany({
    where: {
      orgId,
      userId: { in: userIds },
      ...(opts?.includeFormerEmployees ? {} : { status: "active" }),
    },
    select: {
      userId: true,
      costRates: {
        select: { effectiveFrom: true, costRate: true },
        orderBy: { effectiveFrom: "desc" },
      },
    },
  });
  return new Map(employees.map((e) => [e.userId, e.costRates]));
}
