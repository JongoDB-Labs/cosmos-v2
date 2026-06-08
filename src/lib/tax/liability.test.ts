import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { summarizeTaxLiability } from "./liability";

const D = (s: string) => new Prisma.Decimal(s);
const line = (dir: "DEBIT" | "CREDIT", amount: string, date: string) => ({
  direction: dir,
  amount: D(amount),
  date: new Date(date),
});

describe("summarizeTaxLiability", () => {
  it("nets credits (billed) minus debits (remitted) into the total", () => {
    const s = summarizeTaxLiability([
      line("CREDIT", "8.25", "2026-05-10"),
      line("CREDIT", "12.00", "2026-06-02"),
      line("DEBIT", "5.00", "2026-06-15"),
    ]);
    expect(s.total).toBe("15.25"); // 8.25 + 12 − 5
  });

  it("groups collected tax by calendar month, ascending", () => {
    const s = summarizeTaxLiability([
      line("CREDIT", "10", "2026-06-20"),
      line("CREDIT", "5", "2026-05-01"),
      line("CREDIT", "3", "2026-05-31"),
    ]);
    expect(s.byMonth).toEqual([
      { month: "2026-05", collected: "8" },
      { month: "2026-06", collected: "10" },
    ]);
  });

  it("is zero for no tax lines", () => {
    expect(summarizeTaxLiability([])).toEqual({ total: "0", byMonth: [] });
  });
});
