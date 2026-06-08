import type { Prisma } from "@prisma/client";

/**
 * Normalized transaction from any statement format.
 * amount is SIGNED, customer perspective (+ in / − out).
 */
export type ParsedTxn = {
  externalId: string | null;
  postedDate: Date;
  amount: Prisma.Decimal;
  description: string;
};
