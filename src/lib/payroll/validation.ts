import { z } from "zod";

const costIn = z
  .union([z.number(), z.string()])
  .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, {
    message: "cost rate must be a non-negative number",
  });

export const employeeSchema = z.object({
  userId: z.string().uuid(),
  employmentType: z.enum(["SALARY", "HOURLY"]).optional(),
  costRate: costIn,
  laborCategory: z.string().trim().min(1).nullish(),
  classification: z.string().trim().min(1).nullish(),
  status: z.string().trim().min(1).optional(),
  startDate: z.coerce.date().nullish(),
  endDate: z.coerce.date().nullish(),
});

export const employeeUpdateSchema = z.object({
  employmentType: z.enum(["SALARY", "HOURLY"]).optional(),
  costRate: costIn.optional(),
  laborCategory: z.string().trim().min(1).nullish(),
  classification: z.string().trim().min(1).nullish(),
  status: z.string().trim().min(1).optional(),
  startDate: z.coerce.date().nullish(),
  endDate: z.coerce.date().nullish(),
});

export const payRunSchema = z.object({
  label: z.string().trim().optional(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});
