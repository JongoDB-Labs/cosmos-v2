/**
 * Invoice lines that re-bill reimbursable costs to the client.
 *
 * Each cost becomes one line ("cost plus X%") or two (the cost, then the
 * markup), by the org's preference (src/lib/finance/markup.ts). Either way
 * every line records how much of it is the cost itself, passed through:
 * that part is posted to Reimbursable Cost Recovery, the rest (the markup) to
 * revenue, so the display choice never changes the books.
 *
 * Client-safe: no server imports.
 */
import { markedUp, type ReimbursableLines } from "./markup";

export type RebillSource = "bill" | "expense";

export interface RebillCost {
  source: RebillSource;
  id: string;
  /** How the cost reads on the invoice, e.g. the vendor and their reference. */
  label: string;
  /** The vendor's exact amount. */
  cost: number;
  /** The markup percent that applies (15 = 15%). */
  pct: number;
}

export type RebillKind = "COMBINED" | "COST" | "MARKUP";

export interface RebillLine {
  description: string;
  quantity: 1;
  unitPrice: number;
  taxRate: 0;
  billId: string | null;
  expenseId: string | null;
  reimbursableKind: RebillKind;
  /** The part of this line that is the cost passed through; the rest is revenue. */
  passThroughAmount: number;
}

/** 15 → "15%", 12.5 → "12.5%": no trailing zeros, at most 4 places (the column's scale). */
export const pctLabel = (pct: number) => `${Number(pct.toFixed(4))}%`;

export function rebillLines(costs: readonly RebillCost[], mode: ReimbursableLines): RebillLine[] {
  const out: RebillLine[] = [];
  for (const c of costs) {
    const { cost, markup, total } = markedUp(c.cost, c.pct);
    const ref = { billId: c.source === "bill" ? c.id : null, expenseId: c.source === "expense" ? c.id : null };
    if (mode === "one") {
      out.push({
        description: markup === 0 ? `${c.label} (at cost)` : `${c.label} (cost plus ${pctLabel(c.pct)})`,
        quantity: 1,
        unitPrice: total,
        taxRate: 0,
        ...ref,
        reimbursableKind: "COMBINED",
        passThroughAmount: cost,
      });
      continue;
    }
    out.push({ description: c.label, quantity: 1, unitPrice: cost, taxRate: 0, ...ref, reimbursableKind: "COST", passThroughAmount: cost });
    // No markup, no markup line: a zero line would only add noise to the invoice.
    if (markup !== 0) {
      out.push({
        description: `Markup ${pctLabel(c.pct)} on ${c.label}`,
        quantity: 1,
        unitPrice: markup,
        taxRate: 0,
        ...ref,
        reimbursableKind: "MARKUP",
        passThroughAmount: 0,
      });
    }
  }
  return out;
}
