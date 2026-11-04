-- Time-off allowances: one person's yearly allowance in hours, where it
-- differs from the org default on organizations.settings.time.timeOff.
-- Only the allowance is stored; used / approved / requested are derived from
-- time_off_requests (src/lib/time/time-off-balance.ts).
--
-- A new table, so nothing existing changes. Safe to re-run.

-- CreateTable
CREATE TABLE IF NOT EXISTS "time_off_allowances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "hours" DECIMAL(7,2) NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_off_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "time_off_allowances_org_id_user_id_year_key" ON "time_off_allowances"("org_id", "user_id", "year");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "time_off_allowances" ADD CONSTRAINT "time_off_allowances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
