import { z } from "zod";

const toNum = (v: number | string) => (typeof v === "number" ? v : Number(v));
const moneyIn = z.union([z.number(), z.string()]);
const nonNegMoneyIn = moneyIn.refine(
  (v) => Number.isFinite(toNum(v)) && toNum(v) >= 0,
  { message: "must be a non-negative number" },
);
const posMoneyIn = moneyIn.refine(
  (v) => Number.isFinite(toNum(v)) && toNum(v) > 0,
  { message: "must be a positive number" },
);

// v1 bills positive amounts only (credit memos are out of scope): quantity > 0,
// unitPrice ≥ 0, taxRate ≥ 0 — so a line amount is never negative.
export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: posMoneyIn.default(1),
  unitPrice: nonNegMoneyIn,
  taxRate: nonNegMoneyIn.optional(),
  productId: z.string().uuid().nullish(),
});

export const invoiceInputSchema = z.object({
  contactId: z.string().uuid().nullish(),
  contractId: z.string().uuid().nullish(),
  billToName: z.string().trim().min(1),
  billToEmail: z.string().email().nullish(),
  dueDate: z.coerce.date().nullish(),
  terms: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(invoiceLineSchema).min(1),
});

export const paymentInputSchema = z.object({
  amount: posMoneyIn,
  method: z.enum(["ach", "card", "check", "wire", "other"]).default("other"),
  reference: z.string().nullish(),
  receivedAt: z.coerce.date().optional(),
});
