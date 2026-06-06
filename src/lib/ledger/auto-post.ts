import { Prisma } from "@prisma/client";
import { ACCOUNT_CODES, resolveAccount } from "./chart-of-accounts";
import { postEntry } from "./posting";
import { revenueToPostingLines, expenseToPostingLines, type MapperAccounts } from "./mappers";

async function accountsFor(orgId: string): Promise<MapperAccounts> {
  const [cash, salesRevenue, operatingExpenses] = await Promise.all([
    resolveAccount(orgId, ACCOUNT_CODES.CASH),
    resolveAccount(orgId, ACCOUNT_CODES.SALES_REVENUE),
    resolveAccount(orgId, ACCOUNT_CODES.OPERATING_EXPENSES),
  ]);
  return { cash, salesRevenue, operatingExpenses };
}

export async function postRevenueToLedger(rev: { id: string; orgId: string; amount: Prisma.Decimal; date: Date; createdById: string; description?: string | null }): Promise<void> {
  await postEntry({ orgId: rev.orgId, createdById: rev.createdById, date: rev.date, source: "REVENUE", sourceId: rev.id, memo: rev.description || "Revenue", lines: revenueToPostingLines(rev, await accountsFor(rev.orgId)) });
}

export async function postExpenseToLedger(exp: { id: string; orgId: string; amount: Prisma.Decimal; date: Date; createdById: string; category?: string | null }): Promise<void> {
  await postEntry({ orgId: exp.orgId, createdById: exp.createdById, date: exp.date, source: "EXPENSE", sourceId: exp.id, memo: exp.category || "Expense", lines: expenseToPostingLines(exp, await accountsFor(exp.orgId)) });
}

/** Await this from a source-doc path, but a ledger failure must NOT break the source op. */
export async function safeAutoPost(fn: () => Promise<void>, context: string): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- deliberately silent: ledger failures must not break source-doc writes; errors are logged to console for observability
  try { await fn(); } catch (err) { console.error(`[ledger] auto-post failed (${context}):`, err); }
}
