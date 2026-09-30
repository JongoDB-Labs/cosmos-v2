-- The weekly report and its per-project entries, promoted from a vertical
-- plugin into core.
--
-- Safe to re-run, because the two installs arrive here differently: a fresh one
-- gets empty tables, while a deployment that already holds this data runs a
-- later migration of its own that moves the rows in and drops the old tables.
--
-- weekly_report_entries.project_phase_id has NO foreign key, deliberately.
-- Whatever names a project's phases is free to delete one, and an entry is a
-- record of a week that already happened -- it keeps the phase name and
-- lifecycle it was written with, so the id is a soft reference and a dangling
-- one costs nothing.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "WeeklyReportStatus" AS ENUM ('DRAFT', 'SUBMITTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "weekly_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "status" "WeeklyReportStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "weekly_report_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "project_phase_id" UUID,
    "phase_name" TEXT NOT NULL,
    "phase_lifecycle" TEXT NOT NULL,
    "budget_health" INTEGER NOT NULL,
    "hours_reported" DOUBLE PRECISION NOT NULL,
    "hours_mismatch_ack" BOOLEAN NOT NULL DEFAULT false,
    "outcomes" JSONB NOT NULL DEFAULT '[]',
    "lookaheads" JSONB NOT NULL DEFAULT '[]',
    "barriers" JSONB NOT NULL DEFAULT '[]',
    "milestone_resolutions" JSONB NOT NULL DEFAULT '[]',
    "wins" JSONB NOT NULL DEFAULT '[]',
    "next_week_lever_milestone_id" UUID,
    "next_week_focus" TEXT NOT NULL DEFAULT '',
    "pace_key" TEXT,
    "overlay_key" TEXT,
    "next_week_pace_key" TEXT,
    "next_week_overlay_key" TEXT,

    CONSTRAINT "weekly_report_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "weekly_reports_org_id_week_start_status_idx" ON "weekly_reports"("org_id", "week_start", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_reports_org_id_user_id_week_start_key" ON "weekly_reports"("org_id", "user_id", "week_start");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "weekly_report_entries_org_id_project_id_idx" ON "weekly_report_entries"("org_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_report_entries_report_id_project_id_key" ON "weekly_report_entries"("report_id", "project_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_reports_org_id_fkey') THEN
    ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_report_entries_org_id_fkey') THEN
    ALTER TABLE "weekly_report_entries" ADD CONSTRAINT "weekly_report_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_report_entries_report_id_fkey') THEN
    ALTER TABLE "weekly_report_entries" ADD CONSTRAINT "weekly_report_entries_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_report_entries_project_id_fkey') THEN
    ALTER TABLE "weekly_report_entries" ADD CONSTRAINT "weekly_report_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
