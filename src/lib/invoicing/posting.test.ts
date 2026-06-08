import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { invoiceToPostingLines, paymentToPostingLines } from "./posting";

const D = (s: string) => new Prisma.Decimal(s);
const accts = { ar: "AR", cash: "CASH", salesRevenue: "REV", salesTaxPayable: "TAX" };

const sum = (lines: { direction: string; amount: Prisma.Decimal }[], dir: string) =>
  lines
    .filter((l) => l.direction === dir)
    .reduce((acc, l) => acc.plus(l.amount), new Prisma.Decimal(0));

describe("invoiceToPostingLines", () => {
  it("Dr AR (total) / Cr Revenue (subtotal) + Cr Sales Tax (taxTotal), balanced", () => {
    const lines = invoiceToPostingLines(
      { subtotal: D("150"), taxTotal: D("8.25"), total: D("158.25") },
      accts,
    );
    expect(sum(lines, "DEBIT").toString()).toBe(sum(lines, "CREDIT").toString()); // balanced
    const ar = lines.find((l) => l.accountId === "AR")!;
    expect(ar.direction).toBe("DEBIT");
    expect(ar.amount.toString()).toBe("158.25");
    expect(lines.find((l) => l.accountId === "REV")!.amount.toString()).toBe("150");
    expect(lines.find((l) => l.accountId === "TAX")!.amount.toString()).toBe("8.25");
  });

  it("omits the tax line when taxTotal is zero (still balanced)", () => {
    const lines = invoiceToPostingLines(
      { subtotal: D("100"), taxTotal: D("0"), total: D("100") },
      accts,
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.accountId === "TAX")).toBe(false);
    expect(sum(lines, "DEBIT").toString()).toBe(sum(lines, "CREDIT").toString());
  });

  it("tags AR + revenue lines with the contractId (DCAA dimension)", () => {
    const lines = invoiceToPostingLines(
      { subtotal: D("100"), taxTotal: D("0"), total: D("100"), contractId: "c1" },
      accts,
    );
    expect(lines.find((l) => l.accountId === "AR")!.contractId).toBe("c1");
  });
});

describe("paymentToPostingLines", () => {
  it("Dr Cash / Cr AR, balanced", () => {
    const lines = paymentToPostingLines({ amount: D("50.00") }, accts);
    expect(lines.find((l) => l.accountId === "CASH")!.direction).toBe("DEBIT");
    expect(lines.find((l) => l.accountId === "AR")!.direction).toBe("CREDIT");
    expect(sum(lines, "DEBIT").toString()).toBe(sum(lines, "CREDIT").toString());
  });
});
