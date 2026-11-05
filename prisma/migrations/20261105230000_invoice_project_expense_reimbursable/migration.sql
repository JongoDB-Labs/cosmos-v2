-- Reimbursables, step one: an invoice can name the project it bills, and an
-- expense can be marked reimbursable (billable to the client).
--
--   1. invoices.project_id: nullable, ON DELETE SET NULL. An invoice is a
--      financial record that outlives the project it billed. Existing invoices
--      name no project, which is what they were.
--   2. expenses.reimbursable: NOT NULL DEFAULT false, so every existing expense
--      stays the firm's cost, as it was.
--
-- Safe to re-run.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "project_id" UUID;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reimbursable" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "invoices_org_id_project_id_idx" ON "invoices"("org_id", "project_id");

DO $$
BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
