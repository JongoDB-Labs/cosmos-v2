import { dateOnlyKey } from "@/lib/time/date-only";

/**
 * Which rate applied on a given day.
 *
 * Today `Employee.costRate` is a single mutable number, so changing it rewrites
 * history: run payroll for March after an April raise and March is priced at
 * April's rate. Contract burn has the same problem — a figure measured against
 * a funded ceiling silently changes when somebody's pay changes.
 *
 * A rate is therefore not a value on a person, it is a value over an INTERVAL.
 *
 * `effectiveFrom` is INCLUSIVE, `effectiveTo` EXCLUSIVE, `null` open-ended. That
 * pairing is what lets consecutive cards abut exactly — [Jan 1, Apr 1) then
 * [Apr 1, null) — with no gap on the boundary day and no overlap. Inclusive-end
 * would make Apr 1 match both, and which one won would depend on sort order.
 *
 * Comparison is on `YYYY-MM-DD` strings, never `Date` objects: ISO dates sort
 * lexicographically, and it keeps a rate boundary from moving with the viewer's
 * timezone the way entry dates once did.
 */
export type RateCardLike = {
  costRate: string | null;
  billRate: string | null;
  /** `YYYY-MM-DD` (or an ISO instant — the day is taken). */
  effectiveFrom: string;
  effectiveTo: string | null;
};

/** Does this card cover `on`? */
export function coversDate(card: RateCardLike, on: string): boolean {
  const day = dateOnlyKey(on);
  const from = dateOnlyKey(card.effectiveFrom);
  if (day < from) return false;
  if (card.effectiveTo == null) return true;
  return day < dateOnlyKey(card.effectiveTo);
}

/**
 * The card in force on `on`, or null.
 *
 * Where several cards cover the day — overlapping intervals are a data error,
 * but one an import or a mis-typed end date can produce — the LATEST
 * `effectiveFrom` wins. That is the most recently stated intent, and picking
 * deterministically beats letting row order decide what someone is paid.
 */
export function rateOn<T extends RateCardLike>(
  cards: readonly T[],
  on: string,
): T | null {
  let best: T | null = null;
  for (const card of cards) {
    if (!coversDate(card, on)) continue;
    if (
      best === null ||
      dateOnlyKey(card.effectiveFrom) > dateOnlyKey(best.effectiveFrom)
    ) {
      best = card;
    }
  }
  return best;
}

/**
 * Close the open-ended card so a new one can start.
 *
 * Rate changes arrive as "from this date onward", and the previous rate has to
 * stop the day before — not be deleted. Deleting it would re-price every past
 * period that referenced it, which is the whole thing this model exists to
 * prevent.
 */
export function supersedingEffectiveTo(newEffectiveFrom: string): string {
  // Exclusive end, so the old card ends exactly where the new one begins.
  return dateOnlyKey(newEffectiveFrom);
}
