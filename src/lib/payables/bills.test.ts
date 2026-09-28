import { describe, it, expect } from "vitest";
import {
  counts,
  paidOn,
  outstanding,
  isPastDue,
  billTotals,
  dueLabel,
  type BillLike,
} from "./bills";

const TODAY = "2026-09-28";

const bill = (over: Partial<BillLike> = {}): BillLike => ({
  status: "OPEN",
  terms: "DUE_DATE",
  dueDate: "2026-10-15",
  amount: 1000,
  amountPaid: 0,
  ...over,
});

describe("counts", () => {
  it("counts what is owed or was paid", () => {
    expect(counts({ status: "OPEN" })).toBe(true);
    expect(counts({ status: "PAID" })).toBe(true);
  });

  it("leaves out a draft and a void", () => {
    // A draft was never entered as owed; a void turned out not to exist.
    expect(counts({ status: "DRAFT" })).toBe(false);
    expect(counts({ status: "VOID" })).toBe(false);
  });
});

describe("outstanding", () => {
  it("is the unpaid remainder", () => {
    expect(outstanding(bill({ amount: 1000, amountPaid: 250 }))).toBe(750);
  });

  it("is never negative when more was paid than the bill", () => {
    expect(outstanding(bill({ amount: 1000, amountPaid: 1200 }))).toBe(0);
    // ...and the overpayment is not counted as paid AGAINST this bill either,
    // or the summary would stop adding up.
    expect(paidOn(bill({ amount: 1000, amountPaid: 1200 }))).toBe(1000);
  });
});

describe("isPastDue", () => {
  it("is past due once the date has gone and money is still owed", () => {
    expect(isPastDue(bill({ dueDate: "2026-09-24" }), TODAY)).toBe(true);
  });

  it("is not past due on the due date itself", () => {
    expect(isPastDue(bill({ dueDate: TODAY }), TODAY)).toBe(false);
  });

  it("NEVER treats a pay-when-paid bill as past due", () => {
    // The whole content of the term: not owed until the client settles. Red on
    // a payables screen is an instruction to go and pay something.
    const pwp = bill({ terms: "PAY_WHEN_PAID", dueDate: "2020-01-01" });
    expect(isPastDue(pwp, TODAY)).toBe(false);
  });

  it("is not past due once it is settled, however late", () => {
    expect(
      isPastDue(bill({ dueDate: "2020-01-01", amountPaid: 1000, status: "PAID" }), TODAY),
    ).toBe(false);
  });

  it("is not past due for a draft or a void", () => {
    expect(isPastDue(bill({ status: "DRAFT", dueDate: "2020-01-01" }), TODAY)).toBe(false);
    expect(isPastDue(bill({ status: "VOID", dueDate: "2020-01-01" }), TODAY)).toBe(false);
  });
});

describe("billTotals", () => {
  const set: BillLike[] = [
    bill({ status: "PAID", amount: 500, amountPaid: 500, dueDate: "2026-09-01" }),
    bill({ amount: 300, amountPaid: 0, dueDate: "2026-10-31" }), // owed, not yet due
    bill({ amount: 200, amountPaid: 0, dueDate: "2026-09-01" }), // past due
    bill({ amount: 100, amountPaid: 40, dueDate: "2026-09-01" }), // part paid, past due
    bill({ status: "DRAFT", amount: 9999 }),
    bill({ status: "VOID", amount: 9999 }),
  ];

  it("splits outstanding money into owed and past due without double-counting", () => {
    const t = billTotals(set, TODAY);
    expect(t.total).toBe(1100); // 500 + 300 + 200 + 100, drafts and voids excluded
    expect(t.paid).toBe(540); // 500 + 40
    expect(t.owed).toBe(300);
    expect(t.pastDue).toBe(260); // 200 + 60
  });

  it("adds up: total = paid + owed + pastDue", () => {
    // The identity the screen depends on. A summary whose parts do not make
    // its whole leaves the reader unable to tell which number to believe.
    const t = billTotals(set, TODAY);
    expect(t.paid + t.owed + t.pastDue).toBe(t.total);
  });

  it("still adds up when a bill was overpaid", () => {
    const t = billTotals([bill({ amount: 100, amountPaid: 250 })], TODAY);
    expect(t.paid + t.owed + t.pastDue).toBe(t.total);
  });

  it("is all zeros for no bills", () => {
    expect(billTotals([], TODAY)).toEqual({ total: 0, paid: 0, owed: 0, pastDue: 0 });
  });
});

describe("dueLabel", () => {
  it("says the term rather than showing a blank", () => {
    expect(dueLabel(bill({ terms: "PAY_WHEN_PAID", dueDate: null }), TODAY)).toBe(
      "Pay when paid",
    );
  });

  it("counts the days once it has gone past", () => {
    expect(dueLabel(bill({ dueDate: "2026-09-24" }), TODAY)).toBe("4 days past due");
    expect(dueLabel(bill({ dueDate: "2026-09-27" }), TODAY)).toBe("1 day past due");
  });

  it("shows the date while it is still ahead", () => {
    expect(dueLabel(bill({ dueDate: "2026-10-15" }), TODAY)).toBe("2026-10-15");
  });
});

describe("dueLabel with a formatter", () => {
  it("renders a plain date through the caller's formatter", () => {
    // The phrasing -- the term, the overdue wording -- stays in one place;
    // only the date formatting belongs to the screen.
    expect(
      dueLabel(bill({ dueDate: "2026-10-15" }), TODAY, (iso) => `on ${iso}`),
    ).toBe("on 2026-10-15");
  });

  it("does not put the formatter anywhere near the term or the overdue text", () => {
    const shout = (iso: string) => iso.toUpperCase();
    expect(dueLabel(bill({ terms: "PAY_WHEN_PAID" }), TODAY, shout)).toBe("Pay when paid");
    expect(dueLabel(bill({ dueDate: "2026-09-24" }), TODAY, shout)).toBe("4 days past due");
  });
});
