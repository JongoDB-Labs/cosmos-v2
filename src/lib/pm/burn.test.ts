// @vitest-environment node
//
// CLIN burn and payroll must report the SAME labour cost for the same hours.
//
// They did not. `burn.ts` converted Decimal rates to `number`, multiplied in
// floating point and accumulated with `+`, while payroll used lib/money —
// Decimal, half-even, rounded per line, exactly as an invoice line or a pay run
// does it. On 400 ordinary entries the two figures differed by 22 cents, and
// the gap grows with volume.
//
// This asserts the AGREEMENT rather than either number in isolation: a test
// that only checked burn's own output would happily lock in whatever burn
// happened to produce.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    clin: { findMany: vi.fn() },
    timeEntry: { findMany: vi.fn() },
    expense: { findMany: vi.fn() },
    employee: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { loadClinsWithBurn } from "./burn";
import { laborCostFor } from "@/lib/payroll/labor";
import { sumMoney, roundMoney, moneyToNumber } from "@/lib/money";

const ORG = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const CLIN = "33333333-3333-3333-3333-333333333333";
const USER = "44444444-4444-4444-4444-444444444444";

/** Awkward-but-ordinary rates and part-hours — the values where float drifts. */
const RATES = ["175.33", "162.47", "208.91", "97.15"];
const HOURS = [0.25, 1.75, 7.5, 6.25, 3.1];

function entries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    clinId: CLIN,
    userId: USER,
    hours: HOURS[i % HOURS.length],
    rate: new Prisma.Decimal(RATES[i % RATES.length]),
    date: new Date("2026-03-15"),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.clin.findMany.mockResolvedValue([
    {
      id: CLIN, code: "0001", title: "Base", status: "active",
      value: new Prisma.Decimal("500000.00"),
      fundedValue: new Prisma.Decimal("250000.00"),
      popStart: null, popEnd: null,
    },
  ]);
  prisma.expense.findMany.mockResolvedValue([]);
  prisma.employee.findMany.mockResolvedValue([]);
});

describe("clinBurn labour cost agrees with payroll", () => {
  it("matches payroll's figure to the cent over 400 entries", async () => {
    const rows = entries(400);
    prisma.timeEntry.findMany.mockResolvedValue(rows);

    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    // Exactly how payroll prices the same labour.
    const payroll = moneyToNumber(
      roundMoney(sumMoney(rows.map((r) => laborCostFor(r.hours, r.rate)))),
    );
    expect(burn.laborCost).toBe(payroll);
  });

  it("does NOT match the old float arithmetic — proving the test bites", async () => {
    // If these ever agreed, the assertion above would be vacuous.
    const rows = entries(400);
    prisma.timeEntry.findMany.mockResolvedValue(rows);

    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    let float = 0;
    for (const r of rows) float += r.hours * Number(r.rate);
    expect(burn.laborCost).not.toBe(float);
  });

  it("falls back to the employee cost rate when the entry has none", async () => {
    prisma.timeEntry.findMany.mockResolvedValue([
      { clinId: CLIN, userId: USER, hours: 3.1, rate: null, date: new Date("2026-03-15") },
    ]);
    prisma.employee.findMany.mockResolvedValue([
      { userId: USER, costRate: new Prisma.Decimal("162.47") },
    ]);

    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    expect(burn.laborCost).toBe(
      moneyToNumber(laborCostFor(3.1, new Prisma.Decimal("162.47"))),
    );
  });

  it("treats a missing rate as zero rather than NaN", async () => {
    // No entry rate and no employee record. NaN would poison every downstream
    // total silently.
    prisma.timeEntry.findMany.mockResolvedValue([
      { clinId: CLIN, userId: USER, hours: 5, rate: null, date: new Date("2026-03-15") },
    ]);

    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    expect(burn.laborCost).toBe(0);
    expect(Number.isNaN(burn.burned)).toBe(false);
  });

  it("burned equals labour plus expenses, exactly", async () => {
    prisma.timeEntry.findMany.mockResolvedValue(entries(50));
    prisma.expense.findMany.mockResolvedValue([
      { clinId: CLIN, amount: new Prisma.Decimal("1234.56"), date: new Date("2026-03-15") },
      { clinId: CLIN, amount: new Prisma.Decimal("87.44"), date: new Date("2026-03-15") },
    ]);

    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    expect(burn.expenseCost).toBe(1322);
    expect(burn.burned).toBe(
      moneyToNumber(
        roundMoney(
          new Prisma.Decimal(burn.laborCost).plus(new Prisma.Decimal(burn.expenseCost)),
        ),
      ),
    );
  });

  it("sums contract ceiling and funded value exactly", async () => {
    prisma.timeEntry.findMany.mockResolvedValue([]);
    const [burn] = await loadClinsWithBurn(ORG, PROJECT);

    // fundedValue is what you are permitted to bill against — it has to be exact.
    expect(burn.value).toBe(500000);
    expect(burn.fundedValue).toBe(250000);
  });
});
