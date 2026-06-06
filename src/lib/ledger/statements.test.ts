import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeTrialBalance, computeProfitAndLoss, computeBalanceSheet, type StmtAccount, type StmtLine } from "./statements";

const D = (n: string) => new Prisma.Decimal(n);
const accounts: StmtAccount[] = [
  { id: "cash", type: "ASSET" }, { id: "rev", type: "REVENUE" }, { id: "rent", type: "EXPENSE" },
  { id: "loan", type: "LIABILITY" }, { id: "eq", type: "EQUITY" },
];
const lines: StmtLine[] = [
  { accountId: "cash", direction: "DEBIT", amount: D("1000") }, { accountId: "rev", direction: "CREDIT", amount: D("1000") },
  { accountId: "rent", direction: "DEBIT", amount: D("300") }, { accountId: "cash", direction: "CREDIT", amount: D("300") },
  { accountId: "cash", direction: "DEBIT", amount: D("500") }, { accountId: "loan", direction: "CREDIT", amount: D("500") },
];

describe("computeTrialBalance", () => {
  it("ties out: total debits == total credits", () => {
    const tb = computeTrialBalance(accounts, lines);
    expect(tb.totalDebits.equals(tb.totalCredits)).toBe(true);
    expect(tb.rows.find((r) => r.accountId === "cash")!.debit.toString()).toBe("1200");
    expect(tb.rows.find((r) => r.accountId === "rev")!.credit.toString()).toBe("1000");
  });
});
describe("computeProfitAndLoss", () => {
  it("netIncome = revenue - expense", () => {
    const pl = computeProfitAndLoss(accounts, lines);
    expect(pl.revenue.toString()).toBe("1000");
    expect(pl.expense.toString()).toBe("300");
    expect(pl.netIncome.toString()).toBe("700");
  });
});
describe("computeBalanceSheet", () => {
  it("assets == liabilities + equity + netIncome", () => {
    const bs = computeBalanceSheet(accounts, lines);
    expect(bs.assets.toString()).toBe("1200");
    expect(bs.liabilities.toString()).toBe("500");
    expect(bs.equity.toString()).toBe("0");
    expect(bs.netIncome.toString()).toBe("700");
    expect(bs.assets.equals(bs.liabilities.plus(bs.equity).plus(bs.netIncome))).toBe(true);
  });
});

describe("statements — net loss + direct equity", () => {
  const accts: StmtAccount[] = [{ id: "cash", type: "ASSET" }, { id: "eq", type: "EQUITY" }, { id: "rev", type: "REVENUE" }, { id: "rent", type: "EXPENSE" }];
  // Owner contributes 1000 to equity; earns 200 revenue; spends 500 rent => net loss 300.
  const ls: StmtLine[] = [
    { accountId: "cash", direction: "DEBIT", amount: D("1000") }, { accountId: "eq", direction: "CREDIT", amount: D("1000") },
    { accountId: "cash", direction: "DEBIT", amount: D("200") }, { accountId: "rev", direction: "CREDIT", amount: D("200") },
    { accountId: "rent", direction: "DEBIT", amount: D("500") }, { accountId: "cash", direction: "CREDIT", amount: D("500") },
  ];
  it("net income is negative and the equation holds with non-zero equity", () => {
    const pl = computeProfitAndLoss(accts, ls);
    expect(pl.netIncome.toString()).toBe("-300");
    const bs = computeBalanceSheet(accts, ls);
    expect(bs.equity.toString()).toBe("1000");
    expect(bs.assets.toString()).toBe("700");          // 1000 + 200 - 500
    expect(bs.assets.equals(bs.liabilities.plus(bs.equity).plus(bs.netIncome))).toBe(true);
  });
});

describe("statements — orphan line guard", () => {
  it("throws if a line references an account not in the chart", () => {
    const accts: StmtAccount[] = [{ id: "cash", type: "ASSET" }];
    const ls: StmtLine[] = [{ accountId: "cash", direction: "DEBIT", amount: D("100") }, { accountId: "ghost", direction: "CREDIT", amount: D("100") }];
    expect(() => computeTrialBalance(accts, ls)).toThrow(/unknown account/i);
  });
});
