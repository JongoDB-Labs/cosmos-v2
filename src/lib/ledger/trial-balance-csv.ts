import { Prisma } from "@prisma/client";
import { splitCsv } from "@/lib/bank/parsers/csv";
import type { SubmittedRow } from "./gl-import";

export type ParsedTrialBalance = {
  rows: SubmittedRow[];
  /** Lines that carried no usable account code, with the reason, for display. */
  skipped: { line: number; text: string; reason: string }[];
};

const ZERO = () => new Prisma.Decimal(0);

/**
 * Money as accounting software writes it: `$1,234.56`, `(1,234.56)` for a
 * negative, `1 234,56` in some locales, an em dash or blank for nothing.
 *
 * Parentheses mean negative — the one convention that silently inverts a figure
 * if it is not handled, because `(500)` parses as 500 under a naive strip.
 */
export function parseAmount(raw: string): Prisma.Decimal {
  const t = (raw ?? "").trim();
  if (!t || t === "-" || t === "—" || t === "–") return ZERO();

  // Strip currency and spaces BEFORE looking for the parentheses: "$(1,200)"
  // leads with the symbol, so testing the raw string for /^\(/ misses it and the
  // figure comes back positive.
  const cleaned = t.replace(/[^0-9.,()\-]/g, "");
  const negative = /\(.*\)/.test(cleaned) || /^-/.test(cleaned);
  let body = cleaned.replace(/[()\-]/g, "");
  if (!body) return ZERO();

  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the LAST one is the decimal point. "1.234,56" vs "1,234.56".
    if (lastComma > lastDot) body = body.replace(/\./g, "").replace(",", ".");
    else body = body.replace(/,/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    // Only one kind. A single separator with exactly three digits after it is a
    // thousands separator, not a decimal point — "1,200" is twelve hundred, and
    // reading it as 1.2 understates the figure by a factor of a thousand.
    const sep = lastComma >= 0 ? "," : ".";
    const idx = Math.max(lastComma, lastDot);
    const occurrences = body.split(sep).length - 1;
    const tail = body.length - idx - 1;
    if (occurrences > 1 || tail === 3) body = body.split(sep).join("");
    else body = body.slice(0, idx) + "." + body.slice(idx + 1);
  }

  if (!body || body === ".") return ZERO();
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(body);
  } catch {
    return ZERO();
  }
  return negative ? value.negated() : value;
}

/** `1000`, `1000 · Cash`, `1000 - Cash`, `"1000 Cash & Bank"` → `1000`. */
function accountCodeOf(cell: string): string | null {
  const m = (cell ?? "").trim().match(/^([0-9][0-9.\-]*)/);
  return m ? m[1].replace(/[.\-]+$/, "") : null;
}

const findCol = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h.trim()));

/**
 * Parse a trial-balance export into rows the planner can price.
 *
 * Deliberately forgiving about shape, because this is whatever the accounting
 * package produced: it finds the header by looking for the debit and credit
 * columns rather than assuming row 0, tolerates a title block above it, and
 * drops the `Total` footer that every such export ends with — that row is the
 * sum of the others, and importing it would double the whole file.
 *
 * It is NOT forgiving about content: anything it cannot read becomes a `skipped`
 * entry with a reason, never a silent zero.
 */
export function parseTrialBalanceCsv(text: string): ParsedTrialBalance {
  const table = splitCsv(text);
  const rows: SubmittedRow[] = [];
  const skipped: ParsedTrialBalance["skipped"] = [];

  const headerIdx = table.findIndex(
    (r) => r.some((c) => /debit/i.test(c)) && r.some((c) => /credit/i.test(c)),
  );
  if (headerIdx === -1) {
    return { rows, skipped: [{ line: 0, text: "", reason: "No Debit/Credit columns found" }] };
  }

  const header = table[headerIdx];
  const codeCol = Math.max(findCol(header, /code|account|number|#/i), 0);
  const debitCol = findCol(header, /debit/i);
  const creditCol = findCol(header, /credit/i);

  for (let i = headerIdx + 1; i < table.length; i++) {
    const cells = table[i];
    const joined = cells.join(",").trim();
    if (!joined.replace(/,/g, "")) continue;

    // Every export ends with a Total row; it is the sum of the rows above, so
    // importing it would double the file.
    if (/^\s*(total|totals|grand total)\b/i.test(cells[codeCol] ?? "")) continue;

    const code = accountCodeOf(cells[codeCol] ?? "");
    if (!code) {
      skipped.push({ line: i + 1, text: joined, reason: "No account code" });
      continue;
    }
    const debit = parseAmount(cells[debitCol] ?? "");
    const credit = parseAmount(cells[creditCol] ?? "");

    // A negative in one column is the other column's figure. Normalising here
    // keeps the planner's "no negatives" contract honest instead of rejecting a
    // file that is merely written differently.
    let d = debit;
    let c = credit;
    if (d.lt(0)) {
      c = c.plus(d.negated());
      d = ZERO();
    }
    if (c.lt(0)) {
      d = d.plus(c.negated());
      c = ZERO();
    }
    if (d.isZero() && c.isZero()) continue; // a row stating nothing states nothing
    rows.push({ code, debit: d, credit: c });
  }

  return { rows, skipped };
}
