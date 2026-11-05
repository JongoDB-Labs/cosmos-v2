-- Markup on reimbursable costs, as a percent (15 = 15%), at the project and
-- the bill level. Both nullable: null inherits the next level up (bill, then
-- project, then the org default in organizations.settings.finance), so every
-- existing row keeps today's behaviour.
--
-- The project's markup lives in its own table, not on projects, so that the
-- project rows every project read returns never carry finance data.

CREATE TABLE IF NOT EXISTS "project_fee_terms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "markup_pct" DECIMAL(7,4),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_fee_terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_fee_terms_project_id_key" ON "project_fee_terms"("project_id");

DO $$ BEGIN
  ALTER TABLE "project_fee_terms"
    ADD CONSTRAINT "project_fee_terms_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "markup_pct" DECIMAL(7,4);
