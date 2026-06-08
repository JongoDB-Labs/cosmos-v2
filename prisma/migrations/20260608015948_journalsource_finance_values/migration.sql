-- Extend JournalSource with the finance-module posting sources (additive).
-- ADD VALUE is non-destructive; IF NOT EXISTS keeps it idempotent/re-runnable.
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'INVOICE';
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'PAYMENT';
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'PAYROLL';
