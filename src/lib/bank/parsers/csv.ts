import { Prisma } from "@prisma/client";
import type { ParsedTxn } from "../types";

/**
 * Column-index mapping for CSV statement imports.
 * Either provide `amount` (single signed column) or `credit` + `debit`
 * (two unsigned columns; result = credit − debit).
 */
export type CsvMapping =
  | { date: number; description: number; amount: number; credit?: never; debit?: never }
  | { date: number; description: number; amount?: never; credit: number; debit: number };

/**
 * RFC-4180-compatible CSV splitter that handles quoted fields with embedded
 * commas and escaped double-quotes ("").
 */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            q = false;
          }
        } else {
          cur += c;
        }
      } else if (c === '"') {
        q = true;
      } else if (c === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/**
 * Parse a CSV bank statement into normalized ParsedTxn records.
 *
 * @param text      - Raw CSV string
 * @param mapping   - Column index mapping (0-based)
 * @param hasHeader - Skip the first row when true (default: true)
 */
export function parseCsv(
  text: string,
  mapping: CsvMapping,
  hasHeader = true,
): ParsedTxn[] {
  const rows = splitCsv(text);
  const body = hasHeader ? rows.slice(1) : rows;

  return body.map((r): ParsedTxn => {
    let amount: Prisma.Decimal;

    if (mapping.amount != null) {
      const raw = (r[mapping.amount] ?? "0").replace(/[$,]/g, "") || "0";
      amount = new Prisma.Decimal(raw);
    } else {
      const creditRaw = (r[mapping.credit] ?? "0").replace(/[$,]/g, "") || "0";
      const debitRaw = (r[mapping.debit] ?? "0").replace(/[$,]/g, "") || "0";
      const credit = new Prisma.Decimal(creditRaw);
      const debit = new Prisma.Decimal(debitRaw);
      amount = credit.minus(debit);
    }

    return {
      externalId: null,
      postedDate: new Date(r[mapping.date]),
      amount,
      description: (r[mapping.description] ?? "").trim(),
    };
  });
}
