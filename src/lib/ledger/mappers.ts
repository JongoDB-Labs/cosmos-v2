import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { postEntry, type PostingLine } from "./posting";
import { ACCOUNT_CODES, resolveAccount, seedSystemCoA } from "./chart-of-accounts";
export type MapperAccounts = { cash: string; salesRevenue: string; operatingExpenses: string };
/** PURE. Revenue → Dr Cash / Cr Sales Revenue (cash-basis v1). */
export function revenueToPostingLines(revenue: { amount: Prisma.Decimal }, accts: MapperAccounts): PostingLine[] {
  return [
    { accountId: accts.cash, direction: "DEBIT", amount: revenue.amount },
    { accountId: accts.salesRevenue, direction: "CREDIT", amount: revenue.amount },
  ];
}
/** PURE. Expense → Dr Operating Expenses / Cr Cash (cash-basis v1). */
export function expenseToPostingLines(expense: { amount: Prisma.Decimal }, accts: MapperAccounts): PostingLine[] {
  return [
    { accountId: accts.operatingExpenses, direction: "DEBIT", amount: expense.amount },
    { accountId: accts.cash, direction: "CREDIT", amount: expense.amount },
  ];
}

export async function backfillLedger(orgId: string): Promise<{
  revenues: { total: number; failed: number };
  expenses: { total: number; failed: number };
  errors: Array<{ source: "REVENUE" | "EXPENSE"; id: string; error: string }>;
}> {
  // Seed the chart of accounts once, then resolve the posting accounts in parallel.
  await seedSystemCoA(orgId);
  const [cash, salesRevenue, operatingExpenses] = await Promise.all([
    resolveAccount(orgId, ACCOUNT_CODES.CASH),
    resolveAccount(orgId, ACCOUNT_CODES.SALES_REVENUE),
    resolveAccount(orgId, ACCOUNT_CODES.OPERATING_EXPENSES),
  ]);
  const accts: MapperAccounts = { cash, salesRevenue, operatingExpenses };

  const [revenues, expenses] = await Promise.all([
    prisma.revenue.findMany({ where: { orgId }, select: { id: true, amount: true, date: true, createdById: true, description: true } }),
    // Only APPROVED expenses are real cash outflows — DRAFT/SUBMITTED/REJECTED must not hit the ledger.
    prisma.expense.findMany({ where: { orgId, status: "APPROVED" }, select: { id: true, amount: true, date: true, createdById: true, category: true } }),
  ]);

  // Per-row isolation: one bad historical row (e.g. amount 0, which assertBalanced rejects) must not abort the whole backfill.
  const errors: Array<{ source: "REVENUE" | "EXPENSE"; id: string; error: string }> = [];
  for (const r of revenues) {
    try {
      await postEntry({ orgId, createdById: r.createdById, date: r.date, source: "REVENUE", sourceId: r.id, memo: r.description || "Revenue", lines: revenueToPostingLines(r, accts) });
    } catch (err) {
      errors.push({ source: "REVENUE", id: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const e of expenses) {
    try {
      await postEntry({ orgId, createdById: e.createdById, date: e.date, source: "EXPENSE", sourceId: e.id, memo: e.category || "Expense", lines: expenseToPostingLines(e, accts) });
    } catch (err) {
      errors.push({ source: "EXPENSE", id: e.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    revenues: { total: revenues.length, failed: errors.filter((x) => x.source === "REVENUE").length },
    expenses: { total: expenses.length, failed: errors.filter((x) => x.source === "EXPENSE").length },
    errors,
  };
}
