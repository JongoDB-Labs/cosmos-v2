// @vitest-environment node
//
// ACCEPTANCE — needs a real Postgres, so it is deliberately outside the hermetic
// `npm test` run. Invoke explicitly:
//   DATABASE_URL=... npx vitest run --config vitest.acceptance.config.ts
//
// What it is here to prove is not that the parser parses, which the unit tests
// cover, but that an imported trial balance lands in the ledger as ONE balanced
// adjusting entry and that the statements then agree with the file — and that a
// corrected re-import of the same period posts only the difference rather than
// being swallowed as a duplicate.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { seedSystemCoA, ACCOUNT_CODES } from "@/lib/ledger/chart-of-accounts";
import { importTrialBalance } from "@/lib/ledger/gl-import-service";
import { parseTrialBalanceCsv } from "@/lib/ledger/trial-balance-csv";
import { profitAndLoss, balanceSheet, trialBalance } from "@/lib/ledger/statements";

const ORG = "5f000000-0000-4000-8000-00000000000e";
const ACTOR = "5f000000-0000-4000-8000-00000000000f";
const asOf = new Date("2026-08-31T00:00:00.000Z");

const CSV = [
  "Trial Balance",
  "As of August 31, 2026",
  "",
  "Account,Debit,Credit",
  "1000 · Cash & Bank,\"12,500.00\",",
  "1100 · Accounts Receivable,\"8,200.00\",",
  "6100 · Labor Expense,\"40,000.00\",",
  "6000 · Operating Expenses,\"15,000.00\",",
  "4100 · Service Revenue,,\"75,700.00\"",
  "TOTAL,\"75,700.00\",\"75,700.00\"",
].join("\n");

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: "TB Import Test", slug: "tb-import-test" },
    update: {},
  });
  await seedSystemCoA(ORG);
});

describe("trial balance import — end to end", () => {
  it("posts one balanced adjusting entry and the statements agree", async () => {
    const { rows, skipped } = parseTrialBalanceCsv(CSV);
    expect(skipped).toHaveLength(0);
    expect(rows).toHaveLength(5);

    const res = await importTrialBalance({ orgId: ORG, asOf, submitted: rows, createdById: ACTOR });
    expect(res.posted).toBe(true);
    // A complete trial balance needs no balancing figure.
    expect(res.plan.residual.toString()).toBe("0");
    expect(res.plan.submittedImbalance.toString()).toBe("0");

    const pl = await profitAndLoss(ORG, undefined, asOf);
    expect(pl.revenue.toString()).toBe("75700");
    expect(pl.expense.toString()).toBe("55000");
    expect(pl.netIncome.toString()).toBe("20700");

    const bs = await balanceSheet(ORG, asOf);
    expect(bs.assets.toString()).toBe("20700"); // 12,500 cash + 8,200 AR

    const tb = await trialBalance(ORG, asOf);
    expect(tb.totalDebits.toString()).toBe(tb.totalCredits.toString());
  });

  it("posts nothing when the same file is imported again", async () => {
    const { rows } = parseTrialBalanceCsv(CSV);
    const res = await importTrialBalance({ orgId: ORG, asOf, submitted: rows, createdById: ACTOR });
    expect(res.posted).toBe(false);
    expect(res).toMatchObject({ reason: "unchanged" });
  });

  it("posts only the difference when a corrected file is imported", async () => {
    // The case a source-key idempotency would have swallowed: same period, new
    // figures. Cash restated 12,500 -> 13,000, revenue 75,700 -> 76,200.
    // Target the revenue LINE, not the TOTAL footer — the footer also carries
    // 75,700 and the parser ignores it, so replacing that changes nothing.
    const corrected = CSV
      .replace("1000 · Cash & Bank,\"12,500.00\"", "1000 · Cash & Bank,\"13,000.00\"")
      .replace("4100 · Service Revenue,,\"75,700.00\"", "4100 · Service Revenue,,\"76,200.00\"");
    const { rows } = parseTrialBalanceCsv(corrected);
    const res = await importTrialBalance({ orgId: ORG, asOf, submitted: rows, createdById: ACTOR });

    expect(res.posted).toBe(true);
    const cash = res.plan.lines.find((l) => l.code === ACCOUNT_CODES.CASH)!;
    expect(cash.delta.toString()).toBe("500"); // only the delta, not the whole balance

    const pl = await profitAndLoss(ORG, undefined, asOf);
    expect(pl.revenue.toString()).toBe("76200");
    const bs = await balanceSheet(ORG, asOf);
    expect(bs.assets.toString()).toBe("21200");

    // Whatever it posted, the books still balance.
    const tb = await trialBalance(ORG, asOf);
    expect(tb.totalDebits.toString()).toBe(tb.totalCredits.toString());
  });
});
