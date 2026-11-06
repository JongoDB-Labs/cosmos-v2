-- Re-billing reimbursable costs on a client invoice.
--
-- expenses.invoice_id: the invoice that re-billed a reimbursable expense, as
-- bills.invoice_id already is for a bill, so neither is billed twice.
-- invoice_line_items gains the bill or expense a re-billed line came from, the
-- kind of line it is, and the part of it that is the cost passed through (the
-- rest is revenue). All nullable: every existing line is an ordinary line.

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "invoice_id" UUID;
CREATE INDEX IF NOT EXISTS "expenses_org_id_invoice_id_idx" ON "expenses"("org_id", "invoice_id");
DO $$ BEGIN
  ALTER TABLE "expenses"
    ADD CONSTRAINT "expenses_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReimbursableLineKind" AS ENUM ('COMBINED', 'COST', 'MARKUP');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "bill_id" UUID;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "expense_id" UUID;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "reimbursable_kind" "ReimbursableLineKind";
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "pass_through_amount" DECIMAL(19,4);
DO $$ BEGIN
  ALTER TABLE "invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_bill_id_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_expense_id_fkey"
    FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
