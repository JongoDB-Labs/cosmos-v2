import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { invoiceToPostingLines, passThroughOf, paymentToPostingLines } from "./posting";
import { invoiceTotals, lineAmount } from "./totals";
import { rebillLines, type RebillCost } from "@/lib/finance/rebill";

const D = (s: string) => new Prisma.Decimal(s);
const accts = { ar: "AR", cash: "CASH", salesRevenue: "REV", salesTaxPayable: "TAX", recovery: "REC" };

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

describe("invoiceToPostingLines with re-billed costs", () => {
  const credit = (lines: ReturnType<typeof invoiceToPostingLines>, id: string) =>
    lines.find((l) => l.accountId === id && l.direction === "CREDIT")?.amount.toString() ?? null;

  /** An invoice as the service builds it: one ordinary line plus the re-billed ones, with tax on the ordinary line. */
  function invoiceOf(costs: RebillCost[], mode: "one" | "two") {
    const lines = [
      { amount: lineAmount(D("1"), D("500")), taxRate: D("0.0825"), passThroughAmount: null },
      ...rebillLines(costs, mode).map((l) => ({
        amount: lineAmount(D(String(l.quantity)), D(String(l.unitPrice))),
        taxRate: D("0"),
        passThroughAmount: D(String(l.passThroughAmount)),
      })),
    ];
    return { ...invoiceTotals(lines), passThrough: passThroughOf(lines) };
  }

  const costs: RebillCost[] = [
    { source: "bill", id: "b1", label: "x", cost: 10.05, pct: 15 },
    { source: "expense", id: "e1", label: "y", cost: 0.3, pct: 12.5 },
    { source: "bill", id: "b2", label: "z", cost: 333.33, pct: 7.25 },
  ];

  for (const mode of ["one", "two"] as const) {
    it(`reconciles AR = revenue + recovery + tax, ${mode === "one" ? "one line" : "two lines"} per cost, rounding included`, () => {
      const inv = invoiceOf(costs, mode);
      const lines = invoiceToPostingLines(inv, accts);
      expect(sum(lines, "DEBIT").toString()).toBe(sum(lines, "CREDIT").toString());
      // Recovery is the costs at cost, exactly.
      expect(credit(lines, "REC")).toBe("343.68");
      // Revenue is the ordinary line plus every markup, rounded per cost: 1.51 + 0.04 + 24.17.
      expect(credit(lines, "REV")).toBe("525.72");
      expect(credit(lines, "TAX")).toBe("41.25");
      expect(lines.find((l) => l.accountId === "AR")!.amount.toString()).toBe("910.65");
    });
  }

  it("posts the same entry whichever way the invoice displays the costs", () => {
    const one = invoiceToPostingLines(invoiceOf(costs, "one"), accts);
    const two = invoiceToPostingLines(invoiceOf(costs, "two"), accts);
    const flat = (ls: typeof one) => ls.map((l) => `${l.accountId}:${l.direction}:${l.amount.toString()}`).sort();
    expect(flat(one)).toEqual(flat(two));
  });

  it("an invoice of costs at cost has no revenue line, only recovery", () => {
    const lines = invoiceToPostingLines({ subtotal: D("1000"), taxTotal: D("0"), total: D("1000"), passThrough: D("1000") }, accts);
    expect(lines.map((l) => l.accountId)).toEqual(["AR", "REC"]);
    expect(sum(lines, "DEBIT").toString()).toBe(sum(lines, "CREDIT").toString());
  });

  it("never books more pass-through than the subtotal, nor a negative one", () => {
    const over = invoiceToPostingLines({ subtotal: D("100"), taxTotal: D("0"), total: D("100"), passThrough: D("150") }, accts);
    expect(credit(over, "REC")).toBe("100");
    expect(credit(over, "REV")).toBeNull();
    const neg = invoiceToPostingLines({ subtotal: D("100"), taxTotal: D("0"), total: D("100"), passThrough: D("-5") }, accts);
    expect(credit(neg, "REC")).toBeNull();
    expect(credit(neg, "REV")).toBe("100");
  });
});
