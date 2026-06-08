import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export type AgingBuckets = {
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  totalOutstanding: string;
};

export type OpenInvoice = {
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  dueDate: Date | null;
};

const DAY_MS = 86_400_000;

/**
 * PURE. Bucket open-invoice balances (total − amountPaid) by days past `dueDate`
 * relative to `today`: not-yet-due → current, then 1-30 / 31-60 / 61-90 / 90+.
 * A null dueDate counts as current. Fully-paid balances are skipped.
 */
export function bucketAging(open: OpenInvoice[], today: Date): AgingBuckets {
  const b = {
    current: new Prisma.Decimal(0),
    d1_30: new Prisma.Decimal(0),
    d31_60: new Prisma.Decimal(0),
    d61_90: new Prisma.Decimal(0),
    d90_plus: new Prisma.Decimal(0),
  };
  for (const inv of open) {
    const balance = inv.total.minus(inv.amountPaid);
    if (!balance.greaterThan(0)) continue;
    const daysOver = inv.dueDate
      ? Math.floor((today.getTime() - inv.dueDate.getTime()) / DAY_MS)
      : 0;
    if (daysOver <= 0) b.current = b.current.plus(balance);
    else if (daysOver <= 30) b.d1_30 = b.d1_30.plus(balance);
    else if (daysOver <= 60) b.d31_60 = b.d31_60.plus(balance);
    else if (daysOver <= 90) b.d61_90 = b.d61_90.plus(balance);
    else b.d90_plus = b.d90_plus.plus(balance);
  }
  const totalOutstanding = b.current
    .plus(b.d1_30)
    .plus(b.d31_60)
    .plus(b.d61_90)
    .plus(b.d90_plus);
  return {
    current: b.current.toString(),
    d1_30: b.d1_30.toString(),
    d31_60: b.d31_60.toString(),
    d61_90: b.d61_90.toString(),
    d90_plus: b.d90_plus.toString(),
    totalOutstanding: totalOutstanding.toString(),
  };
}

export async function agingSummary(orgId: string): Promise<AgingBuckets> {
  const open = await prisma.invoice.findMany({
    where: { orgId, status: { in: ["SENT", "PARTIAL"] } },
    select: { total: true, amountPaid: true, dueDate: true },
  });
  return bucketAging(open, new Date());
}
