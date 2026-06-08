import { Prisma } from "@prisma/client";
import { sumMoney, roundMoney } from "@/lib/money";

/** qty × unitPrice, rounded half-even to cents. */
export function lineAmount(
  quantity: Prisma.Decimal,
  unitPrice: Prisma.Decimal,
): Prisma.Decimal {
  return roundMoney(unitPrice.times(quantity));
}

/** Tax on a line amount at its rate (0.0825 = 8.25%), rounded to cents. */
export function lineTax(
  amount: Prisma.Decimal,
  taxRate: Prisma.Decimal,
): Prisma.Decimal {
  return roundMoney(amount.times(taxRate));
}

export type InvoiceTotals = {
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
};

/**
 * Fold computed line items into invoice totals. `subtotal` = Σ line amounts;
 * `taxTotal` = Σ per-line tax; `total` = subtotal + taxTotal. All half-even cents.
 */
export function invoiceTotals(
  lines: { amount: Prisma.Decimal; taxRate: Prisma.Decimal }[],
): InvoiceTotals {
  const subtotal = sumMoney(lines.map((l) => l.amount));
  const taxTotal = sumMoney(lines.map((l) => lineTax(l.amount, l.taxRate)));
  return { subtotal, taxTotal, total: subtotal.plus(taxTotal) };
}

export type InvoiceStatusValue = "DRAFT" | "SENT" | "PARTIAL" | "PAID" | "VOID";

/**
 * Recompute an issued invoice's status from its total + amountPaid. Never changes
 * DRAFT (not issued) or VOID (terminal). PAID requires a positive total fully
 * covered; any partial payment → PARTIAL; otherwise the issued invoice stays SENT.
 */
export function statusFor(
  total: Prisma.Decimal,
  amountPaid: Prisma.Decimal,
  current: InvoiceStatusValue,
): InvoiceStatusValue {
  if (current === "DRAFT" || current === "VOID") return current;
  if (total.greaterThan(0) && amountPaid.greaterThanOrEqualTo(total)) return "PAID";
  if (amountPaid.greaterThan(0)) return "PARTIAL";
  return "SENT";
}
