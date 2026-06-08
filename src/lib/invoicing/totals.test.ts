import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { lineAmount, lineTax, invoiceTotals, statusFor } from "./totals";

const D = (s: string | number) => new Prisma.Decimal(s);

describe("lineAmount", () => {
  it("multiplies qty × unitPrice to cents", () => {
    expect(lineAmount(D(3), D("10.00")).toString()).toBe("30");
    expect(lineAmount(D("2.5"), D("4")).toString()).toBe("10");
  });
  it("rounds half-even to cents", () => {
    expect(lineAmount(D(1), D("0.005")).toString()).toBe("0"); // 0.005 → 0.00 (banker's)
    expect(lineAmount(D(1), D("0.015")).toString()).toBe("0.02");
  });
});

describe("lineTax", () => {
  it("applies a rate and rounds to cents", () => {
    expect(lineTax(D("100"), D("0.0825")).toString()).toBe("8.25");
    expect(lineTax(D("33.33"), D("0.1")).toString()).toBe("3.33");
  });
  it("is zero for a zero rate", () => {
    expect(lineTax(D("100"), D("0")).toString()).toBe("0");
  });
});

describe("invoiceTotals", () => {
  it("sums subtotal, per-line tax, and total", () => {
    const t = invoiceTotals([
      { amount: D("100.00"), taxRate: D("0.0825") },
      { amount: D("50.00"), taxRate: D("0") },
    ]);
    expect(t.subtotal.toString()).toBe("150");
    expect(t.taxTotal.toString()).toBe("8.25");
    expect(t.total.toString()).toBe("158.25");
  });
  it("is all-zero for no lines", () => {
    const t = invoiceTotals([]);
    expect(t.subtotal.toString()).toBe("0");
    expect(t.total.toString()).toBe("0");
  });
});

describe("statusFor", () => {
  it("keeps DRAFT and VOID untouched", () => {
    expect(statusFor(D("100"), D("100"), "DRAFT")).toBe("DRAFT");
    expect(statusFor(D("100"), D("0"), "VOID")).toBe("VOID");
  });
  it("PAID when paid covers a positive total", () => {
    expect(statusFor(D("100"), D("100"), "SENT")).toBe("PAID");
    expect(statusFor(D("100"), D("120"), "PARTIAL")).toBe("PAID");
  });
  it("PARTIAL on a partial payment", () => {
    expect(statusFor(D("100"), D("40"), "SENT")).toBe("PARTIAL");
  });
  it("stays SENT with no payment", () => {
    expect(statusFor(D("100"), D("0"), "SENT")).toBe("SENT");
  });
  it("does not mark a zero-total invoice PAID", () => {
    expect(statusFor(D("0"), D("0"), "SENT")).toBe("SENT");
  });
});
