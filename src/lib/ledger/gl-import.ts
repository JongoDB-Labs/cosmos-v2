import { Prisma } from "@prisma/client";
import { ACCOUNT_CODES } from "./chart-of-accounts";

const ZERO = () => new Prisma.Decimal(0);

/** One row of a submitted trial balance: an account's ENDING balance. */
export type SubmittedRow = {
  code: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
};

/** An account's current position in the ledger, debit-positive. */
export type CurrentBalance = {
  code: string;
  name: string;
  /** Debit-positive: assets/expenses positive, liabilities/equity/revenue negative. */
  balance: Prisma.Decimal;
};

export type PlannedLine = {
  code: string;
  name: string;
  current: Prisma.Decimal;
  target: Prisma.Decimal;
  /** target − current, debit-positive. Positive debits the account. */
  delta: Prisma.Decimal;
};

export type GlImportPlan = {
  lines: PlannedLine[];
  /** The balancing figure routed to Opening Balance Equity, debit-positive. */
  residual: Prisma.Decimal;
  /**
   * The submitted figures' OWN imbalance (debits − credits), reported separately
   * from `residual` so the caller can tell a lopsided file apart from a lopsided
   * ledger. Zero for a real trial-balance export; non-zero is normal for hand
   * entry, where the equity side is exactly what nobody types.
   */
  submittedImbalance: Prisma.Decimal;
  /** True when every delta is zero — re-importing the same figures changes nothing. */
  unchanged: boolean;
};

export class GlImportError extends Error {}

/**
 * PURE. Work out the adjusting entry that moves the ledger to a submitted trial
 * balance.
 *
 * Semantics worth being precise about, because they are not the only defensible
 * ones: this reconciles ONLY the accounts the file lists. An account the ledger
 * knows about but the file omits is left alone, not zeroed. A partial upload is
 * the common case — someone pastes the four lines they care about — and zeroing
 * everything else would silently erase the rest of the ledger.
 *
 * The cost of that choice is that the deltas over a subset do not have to sum to
 * zero, so the entry needs a balancing figure. It goes to Opening Balance Equity:
 * named, visible on the balance sheet, and the same account QuickBooks uses for
 * the same purpose, so it is recognisable to whoever produced the file. A
 * complete trial balance drives it to zero on its own — which is the signal that
 * an import was whole.
 */
export function planGlImport(
  submitted: SubmittedRow[],
  current: CurrentBalance[],
): GlImportPlan {
  const seen = new Set<string>();
  for (const row of submitted) {
    if (seen.has(row.code)) {
      throw new GlImportError(`Account ${row.code} appears more than once`);
    }
    seen.add(row.code);
    if (row.debit.lt(0) || row.credit.lt(0)) {
      throw new GlImportError(`Account ${row.code} has a negative amount — put it in the other column instead`);
    }
    if (row.debit.gt(0) && row.credit.gt(0)) {
      throw new GlImportError(`Account ${row.code} has both a debit and a credit`);
    }
  }

  // Measured, not refused. A trial-balance export always balances, but hand
  // entry does not: someone typing revenue, labour, overhead, AR and cash has
  // not typed the equity side, and that is not an error. The difference is
  // reported so a caller can show it and a typo cannot hide inside the residual.
  const totalDebit = submitted.reduce((s, r) => s.plus(r.debit), ZERO());
  const totalCredit = submitted.reduce((s, r) => s.plus(r.credit), ZERO());
  const submittedImbalance = totalDebit.minus(totalCredit);

  const byCode = new Map(current.map((c) => [c.code, c]));
  const lines: PlannedLine[] = [];
  for (const row of submitted) {
    const account = byCode.get(row.code);
    if (!account) {
      // Unknown codes are refused rather than created: a typo would otherwise
      // invent an account and park real money in it.
      throw new GlImportError(`Unknown account code ${row.code}`);
    }
    const target = row.debit.minus(row.credit);
    const delta = target.minus(account.balance);
    if (delta.isZero()) continue;
    lines.push({ code: row.code, name: account.name, current: account.balance, target, delta });
  }

  const residual = lines.reduce((s, l) => s.plus(l.delta), ZERO()).negated();
  return { lines, residual, submittedImbalance, unchanged: lines.length === 0 };
}

/** The posting lines for a plan: one per changed account, plus the balancing figure. */
export function planToPostingLines(plan: GlImportPlan) {
  const out = plan.lines.map((l) => ({
    code: l.code,
    direction: l.delta.gt(0) ? ("DEBIT" as const) : ("CREDIT" as const),
    amount: l.delta.abs(),
  }));
  if (!plan.residual.isZero()) {
    out.push({
      code: ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
      direction: plan.residual.gt(0) ? ("DEBIT" as const) : ("CREDIT" as const),
      amount: plan.residual.abs(),
    });
  }
  return out;
}
