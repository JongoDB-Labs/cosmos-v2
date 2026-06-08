import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { bucketAging } from "./aging";

const D = (s: string) => new Prisma.Decimal(s);
const today = new Date("2026-06-05T00:00:00Z");
const due = (daysAgo: number) =>
  new Date(today.getTime() - daysAgo * 86_400_000);

describe("bucketAging", () => {
  it("buckets balances by days past due", () => {
    const a = bucketAging(
      [
        { total: D("100"), amountPaid: D("0"), dueDate: due(-5) }, // not yet due → current
        { total: D("200"), amountPaid: D("50"), dueDate: due(10) }, // 10 over → 1-30 (bal 150)
        { total: D("300"), amountPaid: D("0"), dueDate: due(45) }, // 31-60
        { total: D("400"), amountPaid: D("0"), dueDate: due(75) }, // 61-90
        { total: D("500"), amountPaid: D("0"), dueDate: due(120) }, // 90+
      ],
      today,
    );
    expect(a.current).toBe("100");
    expect(a.d1_30).toBe("150");
    expect(a.d31_60).toBe("300");
    expect(a.d61_90).toBe("400");
    expect(a.d90_plus).toBe("500");
    expect(a.totalOutstanding).toBe("1450");
  });

  it("treats a null dueDate as current and skips fully-paid balances", () => {
    const a = bucketAging(
      [
        { total: D("100"), amountPaid: D("0"), dueDate: null },
        { total: D("100"), amountPaid: D("100"), dueDate: due(60) }, // paid → skipped
      ],
      today,
    );
    expect(a.current).toBe("100");
    expect(a.totalOutstanding).toBe("100");
  });
});
