import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { assertBalanced, reversedLines, isVoidable, type PostingLine } from "./posting";

const D = (n: string) => new Prisma.Decimal(n);
const line = (direction: "DEBIT" | "CREDIT", amount: string): PostingLine => ({
  accountId: "00000000-0000-4000-8000-000000000001", direction, amount: D(amount),
});

describe("assertBalanced", () => {
  it("accepts a balanced entry (Dr 100 / Cr 100)", () => {
    expect(() => assertBalanced([line("DEBIT", "100.00"), line("CREDIT", "100.00")])).not.toThrow();
  });
  it("accepts a split balanced entry (Dr 100 / Cr 60 / Cr 40)", () => {
    expect(() => assertBalanced([line("DEBIT", "100"), line("CREDIT", "60"), line("CREDIT", "40")])).not.toThrow();
  });
  it("rejects an unbalanced entry (Dr 100 / Cr 90)", () => {
    expect(() => assertBalanced([line("DEBIT", "100"), line("CREDIT", "90")])).toThrow(/unbalanced/i);
  });
  it("rejects fewer than two lines", () => {
    expect(() => assertBalanced([line("DEBIT", "100")])).toThrow(/two lines/i);
  });
  it("rejects a zero/negative side (Dr 0 / Cr 0)", () => {
    expect(() => assertBalanced([line("DEBIT", "0"), line("CREDIT", "0")])).toThrow(/positive/i);
  });
  it("is exact on fractional cents (Dr 0.10 / Cr 0.10 balances)", () => {
    expect(() => assertBalanced([line("DEBIT", "0.10"), line("CREDIT", "0.10")])).not.toThrow();
  });
  it("rejects a negative line amount even if sides sum equal (Dr 100 / Dr -50 / Cr 50)", () => {
    expect(() => assertBalanced([line("DEBIT", "100"), line("DEBIT", "-50"), line("CREDIT", "50")])).toThrow(/positive/i);
  });
});

describe("isVoidable", () => {
  it("allows voiding a POSTED entry that has not been reversed", () => {
    expect(isVoidable({ status: "POSTED", reversedBy: [] })).toBe(true);
  });
  it("refuses a non-POSTED entry", () => {
    expect(isVoidable({ status: "VOID", reversedBy: [] })).toBe(false);
  });
  it("refuses an entry that has a reversal", () => {
    expect(isVoidable({ status: "POSTED", reversedBy: [{ id: "x" }] })).toBe(false);
  });
});

describe("reversedLines", () => {
  it("swaps DEBIT<->CREDIT and preserves amount + dimensions", () => {
    const orig: PostingLine[] = [
      { accountId: "a1", direction: "DEBIT", amount: D("100"), projectId: "p1" },
      { accountId: "a2", direction: "CREDIT", amount: D("100"), contractId: "c1" },
    ];
    const rev = reversedLines(orig);
    expect(rev[0]).toMatchObject({ accountId: "a1", direction: "CREDIT", projectId: "p1" });
    expect(rev[1]).toMatchObject({ accountId: "a2", direction: "DEBIT", contractId: "c1" });
    expect(rev[0].amount.toString()).toBe("100");
    expect(() => assertBalanced(rev)).not.toThrow();
  });
});
