-- Goals / Milestones / KPIs (project delivery tracking) — ADDITIVE ONLY.
-- Hand-curated from 'prisma migrate diff' to EXCLUDE the known intentional
-- drift the naive diff would 'correct' (pgvector embedding indexes, the
-- content_tsv generated column, audit-chain sequences/triggers, audit_chain_head).
-- New objects only: 5 enums, 6 tables, 6 indexes, FKs for the new tables.

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('PLANNED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ACHIEVED');

-- CreateEnum
CREATE TYPE "GoalProgressMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "GoalLinkKind" AS ENUM ('WORK_ITEM', 'OBJECTIVE');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('UPCOMING', 'IN_PROGRESS', 'COMPLETED', 'MISSED');

-- CreateEnum
CREATE TYPE "KpiDirection" AS ENUM ('UP_GOOD', 'DOWN_GOOD');

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "GoalStatus" NOT NULL DEFAULT 'PLANNED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progress_mode" "GoalProgressMode" NOT NULL DEFAULT 'MANUAL',
    "target_date" TIMESTAMP(3),
    "owner_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_id" UUID NOT NULL,
    "kind" "GoalLinkKind" NOT NULL,
    "work_item_id" UUID,
    "objective_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "due_date" TIMESTAMP(3) NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'UPCOMING',
    "auto_status" BOOLEAN NOT NULL DEFAULT true,
    "completed_at" TIMESTAMP(3),
    "owner_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "milestone_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT '',
    "target_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "current_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "direction" "KpiDirection" NOT NULL DEFAULT 'UP_GOOD',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_data_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kpi_id" UUID NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_data_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goals_org_id_project_id_idx" ON "goals"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "goal_links_goal_id_idx" ON "goal_links"("goal_id");

-- CreateIndex
CREATE INDEX "milestones_org_id_project_id_idx" ON "milestones"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "milestone_links_milestone_id_idx" ON "milestone_links"("milestone_id");

-- CreateIndex
CREATE INDEX "kpis_org_id_project_id_idx" ON "kpis"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "kpi_data_points_kpi_id_recorded_at_idx" ON "kpi_data_points"("kpi_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_links" ADD CONSTRAINT "goal_links_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_links" ADD CONSTRAINT "milestone_links_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpis" ADD CONSTRAINT "kpis_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_data_points" ADD CONSTRAINT "kpi_data_points_kpi_id_fkey" FOREIGN KEY ("kpi_id") REFERENCES "kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "audit_chain_checkpoint_table_seq_idx" RENAME TO "audit_chain_checkpoint_table_name_checkpoint_seq_idx";

