import { describe, it, expect } from "vitest";
import { DEFAULT_COA, ACCOUNT_CODES } from "./chart-of-accounts";
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);
describe("DEFAULT_COA", () => {
  it("has unique account codes", () => {
    const codes = DEFAULT_COA.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("normalBalance matches account type (ASSET/EXPENSE=DEBIT, else CREDIT)", () => {
    for (const a of DEFAULT_COA) expect(a.normalBalance).toBe(DEBIT_NORMAL.has(a.type) ? "DEBIT" : "CREDIT");
  });
  it("includes every code referenced by ACCOUNT_CODES", () => {
    const codes = new Set(DEFAULT_COA.map((a) => a.code));
    for (const code of Object.values(ACCOUNT_CODES)) expect(codes.has(code)).toBe(true);
  });
  it("has at least one account of each of the 5 types", () => {
    for (const t of ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]) expect(DEFAULT_COA.some((a) => a.type === t)).toBe(true);
  });
});
