import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ACCOUNT_CODES, resolveAccount } from "@/lib/ledger/chart-of-accounts";
import { postEntry, reverseEntry, type PostingLine } from "@/lib/ledger/posting";

export type InvoicingAccounts = {
  ar: string;
  cash: string;
  salesRevenue: string;
  salesTaxPayable: string;
};

/** Resolve (lazy-seed) the accounts an invoice/payment posts to. */
export async function invoicingAccounts(orgId: string): Promise<InvoicingAccounts> {
  const [ar, cash, salesRevenue, salesTaxPayable] = await Promise.all([
    resolveAccount(orgId, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
    resolveAccount(orgId, ACCOUNT_CODES.CASH),
    resolveAccount(orgId, ACCOUNT_CODES.SALES_REVENUE),
    resolveAccount(orgId, ACCOUNT_CODES.SALES_TAX_PAYABLE),
  ]);
  return { ar, cash, salesRevenue, salesTaxPayable };
}

/**
 * PURE. Invoice issued (accrual) → Dr Accounts Receivable (total) /
 * Cr Sales Revenue (subtotal) + Cr Sales Tax Payable (taxTotal). The tax credit is
 * omitted when zero. Balances because total = subtotal + taxTotal.
 */
export function invoiceToPostingLines(
  inv: {
    subtotal: Prisma.Decimal;
    taxTotal: Prisma.Decimal;
    total: Prisma.Decimal;
    contractId?: string | null;
  },
  accts: InvoicingAccounts,
): PostingLine[] {
  const lines: PostingLine[] = [
    { accountId: accts.ar, direction: "DEBIT", amount: inv.total, contractId: inv.contractId ?? null },
    { accountId: accts.salesRevenue, direction: "CREDIT", amount: inv.subtotal, contractId: inv.contractId ?? null },
  ];
  if (!inv.taxTotal.isZero()) {
    lines.push({ accountId: accts.salesTaxPayable, direction: "CREDIT", amount: inv.taxTotal });
  }
  return lines;
}

/** PURE. Payment received → Dr Cash / Cr Accounts Receivable. */
export function paymentToPostingLines(
  pay: { amount: Prisma.Decimal },
  accts: InvoicingAccounts,
): PostingLine[] {
  return [
    { accountId: accts.cash, direction: "DEBIT", amount: pay.amount },
    { accountId: accts.ar, direction: "CREDIT", amount: pay.amount },
  ];
}

/** Post the accrual entry for an issued invoice (idempotent on source INVOICE + id). */
export async function postInvoiceToLedger(inv: {
  id: string;
  orgId: string;
  number: string;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  issueDate: Date | null;
  contractId?: string | null;
  createdById: string;
}): Promise<void> {
  await postEntry({
    orgId: inv.orgId,
    createdById: inv.createdById,
    date: inv.issueDate ?? new Date(),
    source: "INVOICE",
    sourceId: inv.id,
    memo: `Invoice ${inv.number}`,
    lines: invoiceToPostingLines(inv, await invoicingAccounts(inv.orgId)),
  });
}

/** Post a payment receipt (idempotent on source PAYMENT + id). */
export async function postPaymentToLedger(pay: {
  id: string;
  orgId: string;
  amount: Prisma.Decimal;
  receivedAt: Date;
  createdById: string;
}): Promise<void> {
  await postEntry({
    orgId: pay.orgId,
    createdById: pay.createdById,
    date: pay.receivedAt,
    source: "PAYMENT",
    sourceId: pay.id,
    memo: "Invoice payment",
    lines: paymentToPostingLines(pay, await invoicingAccounts(pay.orgId)),
  });
}

/** Reverse an invoice's accrual entry on VOID. No-op if it was never posted. */
export async function reverseInvoiceLedger(
  orgId: string,
  invoiceId: string,
  createdById: string,
): Promise<void> {
  const entry = await prisma.journalEntry.findFirst({
    where: { orgId, source: "INVOICE", sourceId: invoiceId, status: "POSTED" },
    select: { id: true },
  });
  if (entry) await reverseEntry(orgId, entry.id, createdById);
}
