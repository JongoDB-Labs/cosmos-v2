import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type StmtAccount = { id: string; type: AccountType; code?: string; name?: string };
export type StmtLine = { accountId: string; direction: "DEBIT" | "CREDIT"; amount: Prisma.Decimal };

const ZERO = () => new Prisma.Decimal(0);

/** Throws if any line references an account not in `accounts` (it would silently vanish from totals). */
function assertClassified(accounts: StmtAccount[], lines: StmtLine[]): void {
  const ids = new Set(accounts.map((a) => a.id));
  const orphan = lines.find((l) => !ids.has(l.accountId));
  if (orphan) throw new Error(`Journal line references unknown account ${orphan.accountId}`);
}

function debitPositiveBalances(lines: StmtLine[]): Map<string, Prisma.Decimal> {
  const m = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    const cur = m.get(l.accountId) ?? ZERO();
    m.set(l.accountId, l.direction === "DEBIT" ? cur.plus(l.amount) : cur.minus(l.amount));
  }
  return m;
}

export function accountNaturalBalance(type: AccountType, debitPositive: Prisma.Decimal): Prisma.Decimal {
  return type === "ASSET" || type === "EXPENSE" ? debitPositive : debitPositive.negated();
}

export function computeTrialBalance(accounts: StmtAccount[], lines: StmtLine[]) {
  assertClassified(accounts, lines);
  const bal = debitPositiveBalances(lines);
  const rows = accounts.map((a) => {
    const dp = bal.get(a.id) ?? ZERO();
    return { accountId: a.id, code: a.code, name: a.name, debit: dp.gt(0) ? dp : ZERO(), credit: dp.lt(0) ? dp.negated() : ZERO() };
  });
  const totalDebits = rows.reduce((s, r) => s.plus(r.debit), ZERO());
  const totalCredits = rows.reduce((s, r) => s.plus(r.credit), ZERO());
  return { rows, totalDebits, totalCredits };
}

export function computeProfitAndLoss(accounts: StmtAccount[], lines: StmtLine[]) {
  assertClassified(accounts, lines);
  const bal = debitPositiveBalances(lines);
  const sumByType = (t: AccountType) => accounts.filter((a) => a.type === t).reduce((s, a) => s.plus(accountNaturalBalance(t, bal.get(a.id) ?? ZERO())), ZERO());
  const revenue = sumByType("REVENUE");
  const expense = sumByType("EXPENSE");
  return { revenue, expense, netIncome: revenue.minus(expense) };
}

export function computeBalanceSheet(accounts: StmtAccount[], lines: StmtLine[]) {
  assertClassified(accounts, lines);
  const bal = debitPositiveBalances(lines);
  const sumByType = (t: AccountType) => accounts.filter((a) => a.type === t).reduce((s, a) => s.plus(accountNaturalBalance(t, bal.get(a.id) ?? ZERO())), ZERO());
  const pl = computeProfitAndLoss(accounts, lines);
  return { assets: sumByType("ASSET"), liabilities: sumByType("LIABILITY"), equity: sumByType("EQUITY"), netIncome: pl.netIncome };
}

async function loadAccountsAndLines(orgId: string, dateWhere?: Prisma.JournalEntryWhereInput) {
  const [accts, lines] = await Promise.all([
    prisma.account.findMany({ where: { orgId }, select: { id: true, type: true, code: true, name: true } }),
    prisma.journalLine.findMany({
      where: { orgId, entry: { status: "POSTED", ...(dateWhere ?? {}) } },
      select: { accountId: true, direction: true, amount: true },
    }),
  ]);
  return { accounts: accts as StmtAccount[], lines: lines as StmtLine[] };
}

export async function trialBalance(orgId: string, asOf?: Date) {
  const { accounts, lines } = await loadAccountsAndLines(orgId, asOf ? { date: { lte: asOf } } : undefined);
  return computeTrialBalance(accounts, lines);
}
export async function profitAndLoss(orgId: string, from?: Date, to?: Date) {
  const dateFilter = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  const { accounts, lines } = await loadAccountsAndLines(orgId, Object.keys(dateFilter).length ? { date: dateFilter } : undefined);
  return computeProfitAndLoss(accounts, lines);
}
export async function balanceSheet(orgId: string, asOf?: Date) {
  const { accounts, lines } = await loadAccountsAndLines(orgId, asOf ? { date: { lte: asOf } } : undefined);
  return computeBalanceSheet(accounts, lines);
}
