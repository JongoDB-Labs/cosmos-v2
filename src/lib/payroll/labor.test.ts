import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { laborCostFor, summarizeLabor } from "./labor";
import { RATE_FLOOR, type CostRateHistory } from "./cost-rates";

const D = (s: string) => new Prisma.Decimal(s);

describe("laborCostFor", () => {
  it("multiplies hours × cost rate to cents", () => {
    expect(laborCostFor(8, D("50.00")).toString()).toBe("400");
    expect(laborCostFor(1.5, D("100")).toString()).toBe("150");
  });
  it("rounds half-even to cents", () => {
    expect(laborCostFor(0.333, D("100")).toString()).toBe("33.3");
    expect(laborCostFor(1, D("33.335")).toString()).toBe("33.34"); // half-even
  });
});

describe("summarizeLabor", () => {
  const on = (s: string) => new Date(`${s}T00:00:00.000Z`);

  // Same rates as before, floored — so these cases assert exactly the arithmetic
  // they always did, and only the lookup underneath them changed.
  const rates: CostRateHistory = new Map([
    ["u1", [{ effectiveFrom: RATE_FLOOR, costRate: D("100") }]],
    ["u2", [{ effectiveFrom: RATE_FLOOR, costRate: D("50") }]],
  ]);

  it("groups cost by project at each user's rate", () => {
    const s = summarizeLabor(
      [
        { userId: "u1", projectId: "p1", hours: 2, date: on("2026-08-03") }, // 200
        { userId: "u2", projectId: "p1", hours: 4, date: on("2026-08-03") }, // 200
        { userId: "u1", projectId: "p2", hours: 1, date: on("2026-08-03") }, // 100
      ],
      rates,
    );
    const p1 = s.byProject.find((g) => g.projectId === "p1")!;
    const p2 = s.byProject.find((g) => g.projectId === "p2")!;
    expect(p1.cost).toBe("400");
    expect(p2.cost).toBe("100");
    expect(s.total).toBe("500");
    expect(s.priced).toBe(3);
    expect(s.unpriced).toBe(0);
  });

  it("skips entries whose user has no cost rate (counts unpriced)", () => {
    const s = summarizeLabor(
      [
        { userId: "u1", projectId: "p1", hours: 1, date: on("2026-08-03") }, // 100
        { userId: "ghost", projectId: "p1", hours: 5, date: on("2026-08-03") }, // no rate → skipped
      ],
      rates,
    );
    expect(s.total).toBe("100");
    expect(s.priced).toBe(1);
    expect(s.unpriced).toBe(1);
  });

  it("buckets project-less labor under the null project", () => {
    const s = summarizeLabor([{ userId: "u2", projectId: null, hours: 3, date: on("2026-08-03") }], rates);
    expect(s.byProject[0].projectId).toBeNull();
    expect(s.byProject[0].cost).toBe("150");
  });
});

describe("summarizeLabor across a rate change", () => {
  const on = (s: string) => new Date(`${s}T00:00:00.000Z`);

  // A raise on 1 Aug. Newest first, as loadCostRateHistory returns them.
  const raised: CostRateHistory = new Map([
    ["u1", [
      { effectiveFrom: on("2026-08-01"), costRate: D("120") },
      { effectiveFrom: RATE_FLOOR, costRate: D("100") },
    ]],
  ]);

  it("costs each hour at the rate in force the day it was worked", () => {
    // The bug this replaced: one period, one rate, so the July hours would have
    // been re-costed at the August rate the moment the raise was entered.
    const s = summarizeLabor(
      [
        { userId: "u1", projectId: "p1", hours: 10, date: on("2026-07-20") }, // 1000
        { userId: "u1", projectId: "p1", hours: 10, date: on("2026-08-10") }, // 1200
      ],
      raised,
    );
    expect(s.byProject.find((g) => g.projectId === "p1")!.cost).toBe("2200");
    expect(s.priced).toBe(2);
  });

  it("applies a new rate from its first day, not the day after", () => {
    const s = summarizeLabor(
      [{ userId: "u1", projectId: "p1", hours: 1, date: on("2026-08-01") }],
      raised,
    );
    expect(s.total).toBe("120");
  });

  it("still uses the older rate on the day before", () => {
    const s = summarizeLabor(
      [{ userId: "u1", projectId: "p1", hours: 1, date: on("2026-07-31") }],
      raised,
    );
    expect(s.total).toBe("100");
  });

  it("counts an hour worked before any rate took effect as unpriced", () => {
    // Not priced at the earliest known rate: nobody had set a rate for that day,
    // and inventing one hides the gap inside a total that looks complete.
    const late: CostRateHistory = new Map([
      ["u1", [{ effectiveFrom: on("2026-08-01"), costRate: D("120") }]],
    ]);
    const s = summarizeLabor(
      [{ userId: "u1", projectId: "p1", hours: 8, date: on("2026-07-15") }],
      late,
    );
    expect(s.total).toBe("0");
    expect(s.priced).toBe(0);
    expect(s.unpriced).toBe(1);
  });
});
