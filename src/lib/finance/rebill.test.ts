import { describe, it, expect } from "vitest";
import { rebillLines, pctLabel, type RebillCost } from "./rebill";

const bill = (over: Partial<RebillCost> = {}): RebillCost => ({ source: "bill", id: "b1", label: "A consultant — R-1", cost: 1000, pct: 15, ...over });

describe("rebillLines", () => {
  it("one line: cost plus markup, with the cost as its pass-through", () => {
    expect(rebillLines([bill()], "one")).toEqual([
      {
        description: "A consultant — R-1 (cost plus 15%)",
        quantity: 1,
        unitPrice: 1150,
        taxRate: 0,
        billId: "b1",
        expenseId: null,
        reimbursableKind: "COMBINED",
        passThroughAmount: 1000,
      },
    ]);
  });

  it("two lines: the cost (all pass-through), then the markup (all revenue)", () => {
    const [cost, markup] = rebillLines([bill({ source: "expense", id: "e1" })], "two");
    expect(cost).toMatchObject({ description: "A consultant — R-1", unitPrice: 1000, expenseId: "e1", billId: null, reimbursableKind: "COST", passThroughAmount: 1000 });
    expect(markup).toMatchObject({ description: "Markup 15% on A consultant — R-1", unitPrice: 150, expenseId: "e1", reimbursableKind: "MARKUP", passThroughAmount: 0 });
  });

  it("at 0% bills at cost: one line says so, two lines drop the empty markup line", () => {
    expect(rebillLines([bill({ pct: 0 })], "one")[0]).toMatchObject({ description: "A consultant — R-1 (at cost)", unitPrice: 1000, passThroughAmount: 1000 });
    const two = rebillLines([bill({ pct: 0 })], "two");
    expect(two).toHaveLength(1);
    expect(two[0].reimbursableKind).toBe("COST");
  });

  it("one line and two lines bill the same, to the cent", () => {
    const costs = [bill({ cost: 10.05, pct: 15 }), bill({ id: "b2", cost: 0.3, pct: 12.5 }), bill({ id: "b3", cost: 333.33, pct: 7.25 })];
    const cents = (ls: { unitPrice: number }[]) => ls.reduce((s, l) => s + Math.round(l.unitPrice * 100), 0);
    const pass = (ls: { passThroughAmount: number }[]) => ls.reduce((s, l) => s + Math.round(l.passThroughAmount * 100), 0);
    const one = rebillLines(costs, "one");
    const two = rebillLines(costs, "two");
    expect(cents(one)).toBe(cents(two));
    expect(pass(one)).toBe(pass(two));
    // 10.05 × 15% = 1.5075 → 1.51
    expect(two[1].unitPrice).toBe(1.51);
  });
});

describe("pctLabel", () => {
  it("drops trailing zeros", () => {
    expect(pctLabel(15)).toBe("15%");
    expect(pctLabel(12.5)).toBe("12.5%");
    expect(pctLabel(7.125)).toBe("7.125%");
  });
});
