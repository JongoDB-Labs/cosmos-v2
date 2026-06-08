import { Prisma } from "@prisma/client";

/** The rule fields the matcher needs (a subset of the BankRule row). */
export type RuleLike = {
  descriptionContains: string | null;
  direction: string; // "any" | "inflow" | "outflow"
  amountMin: Prisma.Decimal | null;
  amountMax: Prisma.Decimal | null;
  category: string;
};

/** The transaction fields the matcher needs. `amount` is signed (− out / + in). */
export type TxnLike = { description: string; amount: Prisma.Decimal };

/**
 * Does this rule match the transaction? Pure. All present conditions must hold
 * (AND); an absent condition (null / "any") is ignored. Amount conditions compare
 * the magnitude, so a user enters positive thresholds regardless of direction.
 */
export function matchRule(rule: RuleLike, txn: TxnLike): boolean {
  // direction: inflow = non-negative amount, outflow = negative amount
  if (rule.direction === "inflow" && txn.amount.isNegative()) return false;
  if (rule.direction === "outflow" && !txn.amount.isNegative()) return false;

  if (rule.descriptionContains) {
    const needle = rule.descriptionContains.toLowerCase();
    if (!txn.description.toLowerCase().includes(needle)) return false;
  }

  const mag = txn.amount.abs();
  if (rule.amountMin !== null && mag.lessThan(rule.amountMin)) return false;
  if (rule.amountMax !== null && mag.greaterThan(rule.amountMax)) return false;

  return true;
}

/**
 * Category of the first matching rule, or null. `rules` must already be ordered
 * by precedence (highest priority first) — `matchRule` is applied in order and the
 * first hit wins.
 */
export function applyRules(rules: RuleLike[], txn: TxnLike): string | null {
  for (const rule of rules) {
    if (matchRule(rule, txn)) return rule.category;
  }
  return null;
}
