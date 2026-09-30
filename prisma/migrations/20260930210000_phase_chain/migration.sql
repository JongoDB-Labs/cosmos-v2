-- The phase chain, promoted from a vertical plugin into core: a configurable
-- phase template, the phases a project actually runs, how their hours fall
-- across time, and the two bindings that say which phase an hour or a milestone
-- belongs to.
--
-- Safe to re-run. A fresh install gets six empty tables; a deployment that
-- already holds this data runs a later migration of its own that moves the rows
-- in and drops the old tables.
--
-- THREE FOREIGN KEYS HERE DID NOT EXIST BEFORE, and could not have. While these
-- tables belonged to a plugin they were forbidden from constraining a core
-- table, so time_entry_phases.org_id, time_entry_phases.time_entry_id and
-- milestone_phases.milestone_id were bare uuids by necessity rather than by
-- design. In core that reason is gone. Each was checked against the reference
-- deployment first and had zero orphans, so the constraint describes the data
-- rather than changing it.
--
-- set_by_id keeps no foreign key: it is nullable by design, and NULL is how
-- "not a person" is meant to be written.

-- CreateTable
CREATE TABLE IF NOT EXISTS "phase_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phase_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "phase_template_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "default_fee_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "suggested_paces" TEXT[],
    "pace_note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "phase_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "template_item_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "fee" DECIMAL(19,4) NOT NULL,
    "fee_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "suggested_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "planned_hours" DOUBLE PRECISION,
    "percent_complete" DECIMAL(5,4),
    "logged_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "invoiced_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paid_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "consumed_hours" DOUBLE PRECISION,
    "start_date" DATE,
    "end_date" DATE,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "phase_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phase_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "time_entry_phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "time_entry_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "set_by_id" UUID,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entry_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "milestone_phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "milestone_id" UUID NOT NULL,
    "project_phase_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestone_phases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "phase_templates_org_id_is_default_idx" ON "phase_templates"("org_id", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "phase_templates_org_id_name_key" ON "phase_templates"("org_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "phase_template_items_template_id_sort_order_idx" ON "phase_template_items"("template_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "phase_template_items_template_id_key_key" ON "phase_template_items"("template_id", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_phases_org_id_project_id_sort_order_idx" ON "project_phases"("org_id", "project_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "project_phases_project_id_name_key" ON "project_phases"("project_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "phase_plans_org_id_week_start_idx" ON "phase_plans"("org_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "phase_plans_phase_id_week_start_key" ON "phase_plans"("phase_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "time_entry_phases_time_entry_id_key" ON "time_entry_phases"("time_entry_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "time_entry_phases_org_id_phase_id_idx" ON "time_entry_phases"("org_id", "phase_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "milestone_phases_milestone_id_key" ON "milestone_phases"("milestone_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "milestone_phases_org_id_idx" ON "milestone_phases"("org_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "milestone_phases_project_phase_id_idx" ON "milestone_phases"("project_phase_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phase_templates_org_id_fkey') THEN
    ALTER TABLE "phase_templates" ADD CONSTRAINT "phase_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phase_template_items_org_id_fkey') THEN
    ALTER TABLE "phase_template_items" ADD CONSTRAINT "phase_template_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phase_template_items_template_id_fkey') THEN
    ALTER TABLE "phase_template_items" ADD CONSTRAINT "phase_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "phase_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_phases_org_id_fkey') THEN
    ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_phases_project_id_fkey') THEN
    ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_phases_template_item_id_fkey') THEN
    ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_template_item_id_fkey" FOREIGN KEY ("template_item_id") REFERENCES "phase_template_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phase_plans_org_id_fkey') THEN
    ALTER TABLE "phase_plans" ADD CONSTRAINT "phase_plans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phase_plans_phase_id_fkey') THEN
    ALTER TABLE "phase_plans" ADD CONSTRAINT "phase_plans_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "project_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entry_phases_org_id_fkey') THEN
    ALTER TABLE "time_entry_phases" ADD CONSTRAINT "time_entry_phases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entry_phases_time_entry_id_fkey') THEN
    ALTER TABLE "time_entry_phases" ADD CONSTRAINT "time_entry_phases_time_entry_id_fkey" FOREIGN KEY ("time_entry_id") REFERENCES "time_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entry_phases_phase_id_fkey') THEN
    ALTER TABLE "time_entry_phases" ADD CONSTRAINT "time_entry_phases_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "project_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_phases_org_id_fkey') THEN
    ALTER TABLE "milestone_phases" ADD CONSTRAINT "milestone_phases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_phases_milestone_id_fkey') THEN
    ALTER TABLE "milestone_phases" ADD CONSTRAINT "milestone_phases_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_phases_project_phase_id_fkey') THEN
    ALTER TABLE "milestone_phases" ADD CONSTRAINT "milestone_phases_project_phase_id_fkey" FOREIGN KEY ("project_phase_id") REFERENCES "project_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
