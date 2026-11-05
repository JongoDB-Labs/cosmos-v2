import { describe, it, expect } from "vitest";
import { financeSettings, resolveMarkup, markedUp, MAX_MARKUP_PCT } from "./markup";

describe("financeSettings", () => {
  it("defaults to no markup on one line when unset", () => {
    expect(financeSettings(null)).toEqual({ reimbursableMarkupPct: 0, reimbursableLines: "one" });
    expect(financeSettings({ finance: {} })).toEqual({ reimbursableMarkupPct: 0, reimbursableLines: "one" });
  });

  it("reads a stored percent and line preference", () => {
    expect(financeSettings({ finance: { reimbursableMarkupPct: 12.5, reimbursableLines: "two" } })).toEqual({
      reimbursableMarkupPct: 12.5,
      reimbursableLines: "two",
    });
  });

  it("ignores a stored value it can't trust", () => {
    for (const bad of [-1, MAX_MARKUP_PCT + 1, "15", Number.NaN, Infinity]) {
      expect(financeSettings({ finance: { reimbursableMarkupPct: bad } }).reimbursableMarkupPct).toBe(0);
    }
    expect(financeSettings({ finance: { reimbursableMarkupPct: MAX_MARKUP_PCT } }).reimbursableMarkupPct).toBe(MAX_MARKUP_PCT);
    expect(financeSettings({ finance: { reimbursableLines: "three" } }).reimbursableLines).toBe("one");
  });
});

describe("resolveMarkup", () => {
  it("takes the bill's own percent first", () => {
    expect(resolveMarkup({ bill: 20, project: 10, org: 5 })).toEqual({ pct: 20, source: "bill" });
  });

  it("falls back to the project, then the org, when the level above is null", () => {
    expect(resolveMarkup({ bill: null, project: 10, org: 5 })).toEqual({ pct: 10, source: "project" });
    expect(resolveMarkup({ bill: null, project: null, org: 5 })).toEqual({ pct: 5, source: "org" });
    expect(resolveMarkup({ org: 5 })).toEqual({ pct: 5, source: "org" });
  });

  it("treats 0 as a real choice that stops the search", () => {
    expect(resolveMarkup({ bill: 0, project: 10, org: 5 })).toEqual({ pct: 0, source: "bill" });
    expect(resolveMarkup({ bill: null, project: 0, org: 5 })).toEqual({ pct: 0, source: "project" });
  });

  it("reads a Prisma Decimal as a number", () => {
    const dec = { toString: () => "12.5000" };
    expect(resolveMarkup({ bill: dec, org: 0 })).toEqual({ pct: 12.5, source: "bill" });
  });
});

describe("markedUp", () => {
  it("adds the markup and keeps the cost exact", () => {
    expect(markedUp(1000, 15)).toEqual({ cost: 1000, markup: 150, total: 1150 });
  });

  it("rounds the markup half-up to the cent, and the total is cost plus markup exactly", () => {
    // 10.05 × 15% = 1.5075 → 1.51
    expect(markedUp(10.05, 15)).toEqual({ cost: 10.05, markup: 1.51, total: 11.56 });
    // 0.1 + 0.2 never reaches an invoice
    const r = markedUp(0.3, 10);
    expect(r.total).toBe(0.33);
    expect(Math.round(r.cost * 100) + Math.round(r.markup * 100)).toBe(Math.round(r.total * 100));
  });

  it("re-bills at cost when the markup is 0", () => {
    expect(markedUp(123.45, 0)).toEqual({ cost: 123.45, markup: 0, total: 123.45 });
  });
});
