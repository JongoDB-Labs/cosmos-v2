-- Six org-scoped tables promoted from a vertical plugin into core.
--
-- Written to be safe to re-run: an existing deployment that already carries
-- this data arrives here with the tables absent and a later migration of its
-- own that moves the rows in. A fresh install gets them empty. Both end up
-- with the same schema, which is the point of promoting them.

-- CreateTable
CREATE TABLE IF NOT EXISTS "pace_levels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percent_label" TEXT NOT NULL DEFAULT '',
    "hours_associate" DOUBLE PRECISION NOT NULL,
    "hours_other" DOUBLE PRECISION NOT NULL,
    "ratio" JSONB NOT NULL DEFAULT '{}',
    "is_temporary" BOOLEAN NOT NULL DEFAULT false,
    "is_overlay" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pace_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pace_weeks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "pace_key" TEXT NOT NULL,
    "lever_milestone_id" UUID,
    "overlay_key" TEXT,
    "overlay_lever_milestone_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT NOT NULL DEFAULT '',
    "set_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pace_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "person_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "source_name" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "set_by_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "milestone_slips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "milestone_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "source_block_id" UUID,
    "recorded_by_id" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_closeout_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INTERIM',
    "data" JSONB NOT NULL,
    "captured_by_id" UUID NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_closeout_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "overhead_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Overhead',
    "hours" DOUBLE PRECISION NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overhead_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pace_levels_org_id_key_key" ON "pace_levels"("org_id", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pace_weeks_org_id_week_start_idx" ON "pace_weeks"("org_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pace_weeks_project_id_week_start_key" ON "pace_weeks"("project_id", "week_start");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "person_aliases_org_id_user_id_idx" ON "person_aliases"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "person_aliases_org_id_source_name_key" ON "person_aliases"("org_id", "source_name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "milestone_slips_org_id_project_id_idx" ON "milestone_slips"("org_id", "project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "milestone_slips_milestone_id_idx" ON "milestone_slips"("milestone_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_closeout_snapshots_org_id_project_id_idx" ON "project_closeout_snapshots"("org_id", "project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "overhead_allocations_org_id_week_start_user_id_idx" ON "overhead_allocations"("org_id", "week_start", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "overhead_allocations_org_id_user_id_week_start_category_key" ON "overhead_allocations"("org_id", "user_id", "week_start", "category");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pace_levels_org_id_fkey') THEN
    ALTER TABLE "pace_levels" ADD CONSTRAINT "pace_levels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pace_weeks_org_id_fkey') THEN
    ALTER TABLE "pace_weeks" ADD CONSTRAINT "pace_weeks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pace_weeks_project_id_fkey') THEN
    ALTER TABLE "pace_weeks" ADD CONSTRAINT "pace_weeks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_aliases_org_id_fkey') THEN
    ALTER TABLE "person_aliases" ADD CONSTRAINT "person_aliases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_slips_org_id_fkey') THEN
    ALTER TABLE "milestone_slips" ADD CONSTRAINT "milestone_slips_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_closeout_snapshots_org_id_fkey') THEN
    ALTER TABLE "project_closeout_snapshots" ADD CONSTRAINT "project_closeout_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_closeout_snapshots_project_id_fkey') THEN
    ALTER TABLE "project_closeout_snapshots" ADD CONSTRAINT "project_closeout_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'overhead_allocations_org_id_fkey') THEN
    ALTER TABLE "overhead_allocations" ADD CONSTRAINT "overhead_allocations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
