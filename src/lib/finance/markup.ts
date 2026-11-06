/**
 * Markup on reimbursable costs.
 *
 * A reimbursable cost (a vendor/partner bill on a project, or an expense marked
 * reimbursable) is re-billed to the client at cost × (1 + markup). The cost
 * keeps the vendor's exact amount everywhere: project cost, actuals and P&L
 * read it. Only the client invoice carries the marked-up figure, and the
 * markup there is revenue while the cost is pass-through.
 *
 * Which percent applies, most specific first: the bill's own, then the
 * project's (its fee terms), then the org's default. A percent of 0 is a real
 * choice ("re-bill at cost") and stops the search, unlike null, which inherits.
 *
 * Client-safe: no server imports.
 */

export type ReimbursableLines = "one" | "two";

export interface FinanceSettings {
  /** The org's default markup, as a percent (15 = 15%). */
  reimbursableMarkupPct: number;
  /** One invoice line ("cost plus X%"), or two (the cost, then the markup). */
  reimbursableLines: ReimbursableLines;
}

export const MAX_MARKUP_PCT = 1000;

const isPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MARKUP_PCT;

/** The org's settings, from Organization.settings.finance. Unset: 0%, one line. */
export function financeSettings(settings: unknown): FinanceSettings {
  const f = ((settings ?? {}) as { finance?: { reimbursableMarkupPct?: unknown; reimbursableLines?: unknown } }).finance;
  return {
    reimbursableMarkupPct: isPct(f?.reimbursableMarkupPct) ? f.reimbursableMarkupPct : 0,
    reimbursableLines: f?.reimbursableLines === "two" ? "two" : "one",
  };
}

export type MarkupSource = "bill" | "project" | "org";

/** A stored percent (a Prisma Decimal, a number, or null) as a number or null. */
const asPct = (v: { toString(): string } | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** The percent that applies to one cost, and where it came from. */
export function resolveMarkup(levels: {
  bill?: { toString(): string } | number | null;
  project?: { toString(): string } | number | null;
  org: number;
}): { pct: number; source: MarkupSource } {
  const bill = asPct(levels.bill);
  if (bill !== null) return { pct: bill, source: "bill" };
  const project = asPct(levels.project);
  if (project !== null) return { pct: project, source: "project" };
  return { pct: levels.org, source: "org" };
}

/**
 * The cost, the markup and the total to bill, in cents-exact amounts.
 *
 * Worked in integer cents so 0.1 + 0.2 never reaches an invoice. The markup is
 * rounded half-up to the cent, and the total is cost + markup exactly, so the
 * one-line and two-line displays always agree to the cent.
 */
export function markedUp(cost: number, pct: number): { cost: number; markup: number; total: number } {
  const costCents = Math.round(cost * 100);
  const markupCents = Math.round((costCents * pct) / 100);
  return { cost: costCents / 100, markup: markupCents / 100, total: (costCents + markupCents) / 100 };
}
