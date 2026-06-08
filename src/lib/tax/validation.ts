import { z } from "zod";

// rate is a fraction (0.0825 = 8.25%) — bounded to a sane 0–1.
const rateIn = z
  .union([z.number(), z.string()])
  .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1, {
    message: "rate must be a fraction between 0 and 1 (e.g. 0.0825 for 8.25%)",
  });

export const taxRateSchema = z.object({
  name: z.string().trim().min(1),
  rate: rateIn,
  jurisdiction: z.string().trim().min(1).nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const taxRateUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  rate: rateIn.optional(),
  jurisdiction: z.string().trim().min(1).nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
