import { prisma } from "@/lib/db/client";
export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type CoaEntry = { code: string; name: string; type: AccountType; normalBalance: "DEBIT" | "CREDIT" };
export const ACCOUNT_CODES = {
  CASH: "1000", ACCOUNTS_RECEIVABLE: "1100", ACCOUNTS_PAYABLE: "2000", SALES_TAX_PAYABLE: "2100",
  ACCRUED_PAYROLL: "2200",
  OWNERS_EQUITY: "3000", OPENING_BALANCE_EQUITY: "3100", RETAINED_EARNINGS: "3900", SALES_REVENUE: "4000", SERVICE_REVENUE: "4100",
  OTHER_INCOME: "4900", COGS: "5000", OPERATING_EXPENSES: "6000", LABOR_EXPENSE: "6100",
} as const;
const normalFor = (type: AccountType): "DEBIT" | "CREDIT" => (type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT");
const coa = (code: string, name: string, type: AccountType): CoaEntry => ({ code, name, type, normalBalance: normalFor(type) });
export const DEFAULT_COA: CoaEntry[] = [
  coa(ACCOUNT_CODES.CASH, "Cash & Bank", "ASSET"),
  coa(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, "Accounts Receivable", "ASSET"),
  coa(ACCOUNT_CODES.ACCOUNTS_PAYABLE, "Accounts Payable", "LIABILITY"),
  coa(ACCOUNT_CODES.SALES_TAX_PAYABLE, "Sales Tax Payable", "LIABILITY"),
  coa(ACCOUNT_CODES.ACCRUED_PAYROLL, "Accrued Payroll", "LIABILITY"),
  coa(ACCOUNT_CODES.OWNERS_EQUITY, "Owner's Equity", "EQUITY"),
  // Where an imported trial balance's residual lands. A full trial balance
  // leaves this at zero; a partial one puts the difference somewhere visible
  // and named, instead of quietly distorting a real account. Same role it plays
  // in QuickBooks, so the number is recognisable to whoever exported the file.
  coa(ACCOUNT_CODES.OPENING_BALANCE_EQUITY, "Opening Balance Equity", "EQUITY"),
  coa(ACCOUNT_CODES.RETAINED_EARNINGS, "Retained Earnings", "EQUITY"),
  coa(ACCOUNT_CODES.SALES_REVENUE, "Sales Revenue", "REVENUE"),
  coa(ACCOUNT_CODES.SERVICE_REVENUE, "Service Revenue", "REVENUE"),
  coa(ACCOUNT_CODES.OTHER_INCOME, "Other Income", "REVENUE"),
  coa(ACCOUNT_CODES.COGS, "Cost of Goods Sold", "EXPENSE"),
  coa(ACCOUNT_CODES.OPERATING_EXPENSES, "Operating Expenses", "EXPENSE"),
  coa(ACCOUNT_CODES.LABOR_EXPENSE, "Labor Expense", "EXPENSE"),
];
export async function seedSystemCoA(orgId: string): Promise<void> {
  await prisma.account.createMany({
    data: DEFAULT_COA.map((a) => ({ orgId, code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance, isSystem: true })),
    skipDuplicates: true,
  });
}
export async function resolveAccount(orgId: string, code: string): Promise<string> {
  let account = await prisma.account.findUnique({ where: { orgId_code: { orgId, code } }, select: { id: true } });
  if (!account) {
    await seedSystemCoA(orgId);
    account = await prisma.account.findUnique({ where: { orgId_code: { orgId, code } }, select: { id: true } });
  }
  if (!account) throw new Error(`Account code ${code} not found for org ${orgId}`);
  return account.id;
}
