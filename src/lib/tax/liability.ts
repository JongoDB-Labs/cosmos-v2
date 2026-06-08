import { Prisma } from "@prisma/client";

export type TaxLine = {
  direction: "DEBIT" | "CREDIT";
  amount: Prisma.Decimal;
  date: Date;
};

export type TaxLiability = {
  /** Net Sales Tax Payable balance owed (credits − debits). */
  total: string;
  /** Collected (net) per calendar month, ascending. */
  byMonth: { month: string; collected: string }[];
};

/**
 * PURE. Net the Sales Tax Payable journal lines into a liability total + a monthly
 * breakdown. Sales Tax Payable is credit-normal, so a CREDIT (tax billed on an
 * invoice) increases the liability and a DEBIT (a future remittance) reduces it.
 */
export function summarizeTaxLiability(lines: TaxLine[]): TaxLiability {
  let total = new Prisma.Decimal(0);
  const byMonth = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    const signed = l.direction === "CREDIT" ? l.amount : l.amount.negated();
    total = total.plus(signed);
    const month = l.date.toISOString().slice(0, 7); // YYYY-MM
    byMonth.set(month, (byMonth.get(month) ?? new Prisma.Decimal(0)).plus(signed));
  }
  return {
    total: total.toString(),
    byMonth: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, collected: v.toString() })),
  };
}
