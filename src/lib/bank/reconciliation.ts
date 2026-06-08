import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/** One status's contribution: how many txns and their net amount (signed). */
export type ReconBucket = { count: number; sum: string };

export type ReconciliationSummary = {
  /** Raw per-status buckets (IMPORTED / POSTED / MATCHED / EXCLUDED / CATEGORIZED). */
  byStatus: Record<string, ReconBucket>;
  /** POSTED + MATCHED — recorded in the books. */
  reconciled: ReconBucket;
  /** IMPORTED — still in the review queue. */
  unreconciled: ReconBucket;
  /** EXCLUDED — deliberately not booked. */
  excluded: ReconBucket;
  /** Every transaction on the account. */
  total: ReconBucket;
  /** reconciled count ÷ (total − excluded) count, 0–100. The progress headline. */
  reconciledPct: number;
};

/** Shape this module consumes from a `groupBy(status)` — kept plain so it's pure-testable. */
export type ReconGroup = { status: string; count: number; sum: Prisma.Decimal | null };

/**
 * Fold per-status groups into the reconciliation summary. Pure (no DB) so the
 * count/sum/percentage math is unit-testable. Sums are net (signed) — counts are
 * the meaningful progress metric, since a status can mix inflows and outflows.
 */
export function summarizeGroups(groups: ReconGroup[]): ReconciliationSummary {
  const bucketFor = (statuses: string[]): ReconBucket => {
    let count = 0;
    let sum = new Prisma.Decimal(0);
    for (const g of groups) {
      if (statuses.includes(g.status)) {
        count += g.count;
        sum = sum.plus(g.sum ?? 0);
      }
    }
    return { count, sum: sum.toString() };
  };

  const byStatus: Record<string, ReconBucket> = {};
  for (const g of groups) {
    byStatus[g.status] = { count: g.count, sum: (g.sum ?? new Prisma.Decimal(0)).toString() };
  }

  const reconciled = bucketFor(["POSTED", "MATCHED"]);
  const unreconciled = bucketFor(["IMPORTED"]);
  const excluded = bucketFor(["EXCLUDED"]);
  const total = bucketFor(["IMPORTED", "CATEGORIZED", "POSTED", "MATCHED", "EXCLUDED"]);
  const denom = total.count - excluded.count;
  const reconciledPct = denom > 0 ? Math.round((reconciled.count / denom) * 100) : 0;

  return { byStatus, reconciled, unreconciled, excluded, total, reconciledPct };
}

/** Reconciliation progress for one bank account — one `groupBy` round-trip. */
export async function reconciliationSummary(
  orgId: string,
  bankAccountId: string,
): Promise<ReconciliationSummary> {
  const groups = await prisma.bankTransaction.groupBy({
    by: ["status"],
    where: { orgId, bankAccountId },
    _count: { _all: true },
    _sum: { amount: true },
  });
  return summarizeGroups(
    groups.map((g) => ({ status: g.status, count: g._count._all, sum: g._sum.amount })),
  );
}
