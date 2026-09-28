/**
 * What the practice owes, and when.
 *
 * The four figures a payables screen leads with -- total, paid, owed, past due
 * -- are not four independent sums. Owed and past due are DISJOINT halves of
 * the same outstanding money, split by whether the date has passed, so
 *
 *     total = paid + owed + pastDue
 *
 * holds for any set of bills. That identity is the point: a payables summary
 * whose parts do not add up to its whole is worse than no summary, because the
 * reader cannot tell which number to believe. `billTotals` is built so the
 * identity is true by construction, and a test asserts it.
 */

export type BillStatusLike = "DRAFT" | "OPEN" | "PAID" | "VOID";
export type BillTermsLike = "DUE_DATE" | "PAY_WHEN_PAID";

export type BillLike = {
  status: BillStatusLike;
  terms: BillTermsLike;
  /** Date-only, YYYY-MM-DD. Null for PAY_WHEN_PAID, and allowed to be null otherwise. */
  dueDate: string | null;
  amount: number;
  amountPaid: number;
};

/**
 * Whether a bill is part of the practice's payables at all.
 *
 * A DRAFT has not been entered as owed, and a VOID one is a bill that turned
 * out not to exist. Counting either would inflate every figure on the screen.
 */
export function counts(b: Pick<BillLike, "status">): boolean {
  return b.status === "OPEN" || b.status === "PAID";
}

/** What has actually been put against this bill, never more than the bill. */
export function paidOn(b: BillLike): number {
  return Math.min(Math.max(b.amountPaid, 0), b.amount);
}

/** Still owed. Never negative -- an overpayment is not a debt in the other direction. */
export function outstanding(b: BillLike): number {
  return Math.max(b.amount - paidOn(b), 0);
}

/**
 * Past due.
 *
 * A PAY_WHEN_PAID bill is NEVER past due, whatever date it happens to carry.
 * That is the whole content of the term: the money is not owed until the
 * client settles the invoice the cost belongs to, so showing it in red would
 * be reporting a debt that has not come due -- and on a payables screen, red
 * is an instruction to go and pay something.
 *
 * A bill with nothing left outstanding is not past due either, however old:
 * paying late settles the debt, it does not leave it standing.
 */
export function isPastDue(b: BillLike, today: string): boolean {
  if (!counts(b)) return false;
  if (b.terms === "PAY_WHEN_PAID") return false;
  if (!b.dueDate) return false;
  if (outstanding(b) <= 0) return false;
  return b.dueDate < today;
}

export type BillTotals = {
  total: number;
  paid: number;
  /** Outstanding on bills whose date has NOT passed. */
  owed: number;
  /** Outstanding on bills whose date HAS passed. Disjoint from `owed`. */
  pastDue: number;
};

export function billTotals(bills: BillLike[], today: string): BillTotals {
  const t: BillTotals = { total: 0, paid: 0, owed: 0, pastDue: 0 };
  for (const b of bills) {
    if (!counts(b)) continue;
    t.total += b.amount;
    t.paid += paidOn(b);
    // The two halves of the same outstanding money, so they can never
    // double-count it and can never leave a remainder.
    if (isPastDue(b, today)) t.pastDue += outstanding(b);
    else t.owed += outstanding(b);
  }
  return t;
}

/**
 * How a due date reads on the screen.
 *
 * "Pay when paid" is a TERM, not a date, and the column has to say so rather
 * than showing a blank that reads as missing data.
 */
export function dueLabel(
  b: BillLike,
  today: string,
  /** How to render a plain date. The default keeps it ISO, which is what the
   *  tests read; a screen passes its own locale formatter. */
  fmt: (iso: string) => string = (iso) => iso,
): string {
  if (b.terms === "PAY_WHEN_PAID") return "Pay when paid";
  if (!b.dueDate) return "—";
  if (!isPastDue(b, today)) return fmt(b.dueDate);
  const days = Math.round(
    (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${b.dueDate}T00:00:00.000Z`)) / 86_400_000,
  );
  return `${days} day${days === 1 ? "" : "s"} past due`;
}
