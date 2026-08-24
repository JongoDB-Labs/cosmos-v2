import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { planGlImport, planToPostingLines, GlImportError, type CurrentBalance } from "./gl-import";
import { assertBalanced } from "./posting";
import { ACCOUNT_CODES } from "./chart-of-accounts";

const D = (n: string | number) => new Prisma.Decimal(n);
const dr = (code: string, n: string | number) => ({ code, debit: D(n), credit: D(0) });
const cr = (code: string, n: string | number) => ({ code, debit: D(0), credit: D(n) });

const CASH = ACCOUNT_CODES.CASH;
const AR = ACCOUNT_CODES.ACCOUNTS_RECEIVABLE;
const REV = ACCOUNT_CODES.SERVICE_REVENUE;
const OBE = ACCOUNT_CODES.OPENING_BALANCE_EQUITY;

/** A ledger that is empty but knows its accounts. */
const empty: CurrentBalance[] = [
  { code: CASH, name: "Cash & Bank", balance: D(0) },
  { code: AR, name: "Accounts Receivable", balance: D(0) },
  { code: REV, name: "Service Revenue", balance: D(0) },
  { code: OBE, name: "Opening Balance Equity", balance: D(0) },
];

/** `assertBalanced` speaks in account IDs; codes are unique here, so they serve. */
const asPostable = (lines: ReturnType<typeof planToPostingLines>) =>
  lines.map((l) => ({ accountId: l.code, direction: l.direction, amount: l.amount }));

describe("planGlImport — deltas", () => {
  it("moves an account from its current balance to the submitted one", () => {
    const current: CurrentBalance[] = [
      { code: CASH, name: "Cash & Bank", balance: D(3000) },
      { code: REV, name: "Service Revenue", balance: D(-3000) },
    ];
    const plan = planGlImport([dr(CASH, 5000), cr(REV, 5000)], current);

    const cash = plan.lines.find((l) => l.code === CASH)!;
    expect(cash.current.toString()).toBe("3000");
    expect(cash.target.toString()).toBe("5000");
    expect(cash.delta.toString()).toBe("2000"); // debit 2000 to get there
  });

  it("reports no change when the ledger already matches", () => {
    const current: CurrentBalance[] = [
      { code: CASH, name: "Cash & Bank", balance: D(5000) },
      { code: REV, name: "Service Revenue", balance: D(-5000) },
    ];
    const plan = planGlImport([dr(CASH, 5000), cr(REV, 5000)], current);
    expect(plan.unchanged).toBe(true);
    expect(plan.lines).toHaveLength(0);
    expect(plan.residual.toString()).toBe("0");
  });

  it("leaves accounts the file does not mention alone", () => {
    const current: CurrentBalance[] = [
      { code: CASH, name: "Cash & Bank", balance: D(0) },
      { code: AR, name: "Accounts Receivable", balance: D(900) },
      { code: REV, name: "Service Revenue", balance: D(-900) },
    ];
    const plan = planGlImport([dr(CASH, 100), cr(REV, 100)], current);
    // AR is untouched — zeroing it would erase a real balance nobody asked about.
    expect(plan.lines.map((l) => l.code)).not.toContain(AR);
  });
});

describe("planGlImport — the entry always balances", () => {
  it("needs no residual for a complete trial balance", () => {
    const plan = planGlImport([dr(CASH, 5000), cr(REV, 5000)], empty);
    expect(plan.residual.toString()).toBe("0");
    expect(planToPostingLines(plan).some((l) => l.code === OBE)).toBe(false);
  });

  it("routes a partial upload's difference to Opening Balance Equity", () => {
    // The file balances, but the accounts it lists do not currently net to zero
    // in the ledger — the rest of that position lives in accounts the file
    // omits. The difference has to land somewhere named.
    const current: CurrentBalance[] = [
      { code: CASH, name: "Cash & Bank", balance: D(1000) },
      { code: REV, name: "Service Revenue", balance: D(0) },
      { code: OBE, name: "Opening Balance Equity", balance: D(0) },
    ];
    const plan = planGlImport([dr(CASH, 4000), cr(REV, 4000)], current);
    expect(plan.submittedImbalance.toString()).toBe("0");
    expect(plan.residual.toString()).toBe("1000"); // debit 1000

    const lines = planToPostingLines(plan);
    const obe = lines.find((l) => l.code === OBE)!;
    expect(obe.direction).toBe("DEBIT");
    expect(obe.amount.toString()).toBe("1000");
  });

  it("produces a balanced entry in every one of these shapes", () => {
    const cases = [
      { submitted: [dr(CASH, 5000), cr(REV, 5000)], current: empty },
      { submitted: [dr(CASH, 4000)], current: empty },                       // lopsided hand entry
      { submitted: [cr(REV, 250)], current: empty },                         // lopsided the other way
      { submitted: [dr(CASH, 10), dr(AR, 90), cr(REV, 100)], current: empty },
      {
        submitted: [dr(CASH, 4000), cr(REV, 4000)],                          // balanced over a non-zero ledger
        current: [
          { code: CASH, name: "Cash & Bank", balance: D(1000) },
          { code: REV, name: "Service Revenue", balance: D(0) },
        ],
      },
    ];
    for (const c of cases) {
      const lines = planToPostingLines(planGlImport(c.submitted, c.current));
      // The real invariant: whatever the plan, postEntry must accept it.
      expect(() => assertBalanced(asPostable(lines))).not.toThrow();
    }
  });
});

describe("planGlImport — refusals", () => {
  it("reports a lopsided submission rather than refusing it", () => {
    // Hand entry legitimately omits the equity side. Refusing would block the
    // manual path; hiding it would let a typo through. So: report it.
    const plan = planGlImport([dr(CASH, 5000), cr(REV, 4000)], empty);
    expect(plan.submittedImbalance.toString()).toBe("1000");
  });

  it("reports zero imbalance for a real trial balance", () => {
    const plan = planGlImport([dr(CASH, 5000), cr(REV, 5000)], empty);
    expect(plan.submittedImbalance.toString()).toBe("0");
  });

  it("refuses an unknown account code rather than inventing the account", () => {
    expect(() => planGlImport([dr("9999", 10), cr(REV, 10)], empty)).toThrow(/Unknown account code 9999/);
  });

  it("refuses the same account twice", () => {
    expect(() => planGlImport([dr(CASH, 10), dr(CASH, 20), cr(REV, 30)], empty)).toThrow(/more than once/);
  });

  it("refuses a row carrying both a debit and a credit", () => {
    expect(() =>
      planGlImport([{ code: CASH, debit: D(10), credit: D(10) }, cr(REV, 0)], empty),
    ).toThrow(/both a debit and a credit/);
  });

  it("refuses a negative amount instead of silently flipping it", () => {
    expect(() =>
      planGlImport([{ code: CASH, debit: D(-10), credit: D(0) }, cr(REV, -10)], empty),
    ).toThrow(/negative amount/);
  });
});
