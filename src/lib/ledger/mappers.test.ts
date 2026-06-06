import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { revenueToPostingLines, expenseToPostingLines } from "./mappers";
import { assertBalanced } from "./posting";
const accts = { cash: "acct-cash", salesRevenue: "acct-rev", operatingExpenses: "acct-exp" };
describe("revenueToPostingLines", () => {
  it("debits Cash and credits Sales Revenue for the amount, balanced", () => {
    const lines = revenueToPostingLines({ amount: new Prisma.Decimal("250.00") }, accts);
    expect(lines).toHaveLength(2);
    const dr = lines.find((l) => l.direction === "DEBIT")!;
    const cr = lines.find((l) => l.direction === "CREDIT")!;
    expect(dr.accountId).toBe(accts.cash);
    expect(cr.accountId).toBe(accts.salesRevenue);
    expect(dr.amount.toString()).toBe("250");
    expect(() => assertBalanced(lines)).not.toThrow();
  });
});
describe("expenseToPostingLines", () => {
  it("debits Operating Expenses and credits Cash for the amount, balanced", () => {
    const lines = expenseToPostingLines({ amount: new Prisma.Decimal("80.50") }, accts);
    const dr = lines.find((l) => l.direction === "DEBIT")!;
    const cr = lines.find((l) => l.direction === "CREDIT")!;
    expect(dr.accountId).toBe(accts.operatingExpenses);
    expect(cr.accountId).toBe(accts.cash);
    expect(cr.amount.toString()).toBe("80.5");
    expect(() => assertBalanced(lines)).not.toThrow();
  });
});
