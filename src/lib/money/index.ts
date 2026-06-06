import { Prisma } from "@prisma/client";

/**
 * Money is stored as Postgres numeric(19,4) ⇄ Prisma.Decimal. NEVER coerce a money
 * value to a JS number for arithmetic — do all math here, in Decimal. (Decimal `+`/`*`
 * is already a TypeScript error, which is the first line of defense.)
 */
export type Money = Prisma.Decimal;

/** Sum Decimal|null money values exactly (nulls skipped). */
export function sumMoney(values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (acc, v) => (v == null ? acc : acc.plus(v)),
    new Prisma.Decimal(0),
  );
}

/**
 * Multiply a money value by a plain quantity (e.g. rate × hours), exactly.
 * Null/undefined → 0 — this is intentional and preserves the existing
 * `hours * (rate ?? 0)` billable-amount semantics this util replaces.
 * `factor` is converted to an exact Decimal, so typical quantities (e.g. 7.5 hours)
 * are safe; pass a string for a factor you cannot guarantee is float-exact.
 */
export function multiplyMoney(value: Prisma.Decimal | null | undefined, factor: number): Prisma.Decimal {
  return value == null ? new Prisma.Decimal(0) : value.times(factor);
}

/** Round to a currency's minor units (default 2dp) using banker's rounding (half-even). */
export function roundMoney(value: Prisma.Decimal, decimalPlaces = 2): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_EVEN);
}

/** Convert to a JS number for DISPLAY / serialization of computed aggregates ONLY. */
export function moneyToNumber(value: Prisma.Decimal): number {
  return value.toNumber();
}
