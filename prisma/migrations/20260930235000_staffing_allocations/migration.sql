-- Hours of one person booked to one project for one week, promoted from a
-- vertical plugin. The chargeable counterpart to overhead_allocations: that one
-- records the hours a week absorbed, this one the hours a week committed.
--
-- Safe to re-run. `band` reuses the Band type core already holds from rate
-- levels rather than creating a second copy of it, which is the small dividend
-- of having promoted that first.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "AllocationSource" AS ENUM ('PACE', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "staffing_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "source" "AllocationSource" NOT NULL DEFAULT 'PACE',
    "pace_key" TEXT,
    "band" "Band",
    "note" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staffing_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "staffing_allocations_org_id_week_start_user_id_idx" ON "staffing_allocations"("org_id", "week_start", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "staffing_allocations_project_id_user_id_week_start_key" ON "staffing_allocations"("project_id", "user_id", "week_start");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staffing_allocations_org_id_fkey') THEN
    ALTER TABLE "staffing_allocations" ADD CONSTRAINT "staffing_allocations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staffing_allocations_project_id_fkey') THEN
    ALTER TABLE "staffing_allocations" ADD CONSTRAINT "staffing_allocations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
