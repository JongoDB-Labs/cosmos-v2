import { describe, expect, it } from "vitest";
import { parseAmount, parseTrialBalanceCsv } from "./trial-balance-csv";

describe("parseAmount", () => {
  it("reads plain and formatted money", () => {
    expect(parseAmount("1234.56").toString()).toBe("1234.56");
    expect(parseAmount("$1,234.56").toString()).toBe("1234.56");
    expect(parseAmount(" 1,234.56 ").toString()).toBe("1234.56");
  });

  it("treats parentheses as negative", () => {
    // The one that silently inverts a figure if unhandled: a naive strip reads
    // (500) as 500 and the balance sheet is out by a thousand.
    expect(parseAmount("(500.00)").toString()).toBe("-500");
    expect(parseAmount("$(1,200)").toString()).toBe("-1200");
  });

  it("reads European separators by whichever comes last", () => {
    expect(parseAmount("1.234,56").toString()).toBe("1234.56");
    expect(parseAmount("1,234.56").toString()).toBe("1234.56");
  });

  it("reads a lone separator with three digits after it as thousands", () => {
    // "1,200" is twelve hundred. Reading it as a decimal point understates the
    // figure by a factor of a thousand, which is the kind of error that looks
    // plausible on a report.
    expect(parseAmount("1,200").toString()).toBe("1200");
    expect(parseAmount("1.200").toString()).toBe("1200");
  });

  it("reads a lone separator with one or two digits after it as a decimal", () => {
    expect(parseAmount("1,20").toString()).toBe("1.2");
    expect(parseAmount("1.5").toString()).toBe("1.5");
  });

  it("handles several thousands groups", () => {
    expect(parseAmount("12,345,678.90").toString()).toBe("12345678.9");
    expect(parseAmount("$12,345,678").toString()).toBe("12345678");
  });

  it("reads a leading minus as negative", () => {
    expect(parseAmount("-500").toString()).toBe("-500");
    expect(parseAmount("-$1,200").toString()).toBe("-1200");
  });

  it("treats blanks and dashes as nothing", () => {
    for (const s of ["", "   ", "-", "—", "–"]) expect(parseAmount(s).toString()).toBe("0");
  });

  it("returns zero rather than NaN for junk", () => {
    expect(parseAmount("n/a").toString()).toBe("0");
  });
});

describe("parseTrialBalanceCsv", () => {
  const qbo = [
    "Alpha Design Co Trial Balance",
    "As of August 31, 2026",
    "",
    "Account,Debit,Credit",
    "1000 · Cash & Bank,\"12,500.00\",",
    "1100 · Accounts Receivable,\"8,200.00\",",
    "4100 · Service Revenue,,\"20,700.00\"",
    "TOTAL,\"20,700.00\",\"20,700.00\"",
  ].join("\n");

  it("finds the header under a title block", () => {
    const { rows } = parseTrialBalanceCsv(qbo);
    expect(rows.map((r) => r.code)).toEqual(["1000", "1100", "4100"]);
  });

  it("splits the code off a 'code · name' cell", () => {
    const { rows } = parseTrialBalanceCsv(qbo);
    expect(rows[0].debit.toString()).toBe("12500");
  });

  it("ignores the TOTAL footer without reporting it as a problem", () => {
    // It is the sum of the rows above; importing it would double the file. It
    // also must not surface as a skipped line — every export ends with one, so
    // flagging it would put a false problem on every single import.
    const { rows, skipped } = parseTrialBalanceCsv(qbo);
    expect(rows.some((r) => r.debit.toString() === "20700")).toBe(false);
    expect(skipped).toHaveLength(0);
  });

  it("puts credits in the credit column", () => {
    const { rows } = parseTrialBalanceCsv(qbo);
    const rev = rows.find((r) => r.code === "4100")!;
    expect(rev.credit.toString()).toBe("20700");
    expect(rev.debit.toString()).toBe("0");
  });

  it("moves a negative debit into the credit column", () => {
    const csv = "Account,Debit,Credit\n4100 Revenue,(20700.00),";
    const { rows } = parseTrialBalanceCsv(csv);
    expect(rows[0].debit.toString()).toBe("0");
    expect(rows[0].credit.toString()).toBe("20700");
  });

  it("reports lines with no account code instead of dropping them silently", () => {
    const csv = "Account,Debit,Credit\nMiscellaneous stuff,100,";
    const { rows, skipped } = parseTrialBalanceCsv(csv);
    expect(rows).toHaveLength(0);
    expect(skipped[0].reason).toBe("No account code");
    expect(skipped[0].line).toBe(2);
  });

  it("says so when the file has no Debit/Credit columns at all", () => {
    const { skipped } = parseTrialBalanceCsv("name,value\nfoo,1");
    expect(skipped[0].reason).toMatch(/No Debit\/Credit/);
  });

  it("ignores rows that state nothing", () => {
    const csv = "Account,Debit,Credit\n1000 Cash,,\n1100 AR,50,";
    const { rows } = parseTrialBalanceCsv(csv);
    expect(rows.map((r) => r.code)).toEqual(["1100"]);
  });
});
