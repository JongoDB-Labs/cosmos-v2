-- Rename the "cycle" domain to "interval" (sprint/phase/PI/release container).
-- Pure, non-destructive renames — no data is transformed or dropped.

-- 1. Enum type: CycleKind -> IntervalKind (values SPRINT/PHASE/... unchanged)
ALTER TYPE "CycleKind" RENAME TO "IntervalKind";

-- 2. LinkedItemType enum value CYCLE -> INTERVAL (existing rows follow automatically)
ALTER TYPE "LinkedItemType" RENAME VALUE 'CYCLE' TO 'INTERVAL';

-- 3. Tables
ALTER TABLE "cycles" RENAME TO "intervals";
ALTER TABLE "cycle_capacities" RENAME TO "interval_capacities";

-- 4. Columns
ALTER TABLE "intervals" RENAME COLUMN "cycle_kind" TO "interval_kind";
ALTER TABLE "interval_capacities" RENAME COLUMN "cycle_id" TO "interval_id";
ALTER TABLE "work_items" RENAME COLUMN "cycle_id" TO "interval_id";

-- 5. Indexes / PK / unique (renamed to match Prisma's naming conventions)
ALTER INDEX "cycles_pkey" RENAME TO "intervals_pkey";
ALTER INDEX "cycles_parent_id_idx" RENAME TO "intervals_parent_id_idx";
ALTER INDEX "cycles_project_id_number_key" RENAME TO "intervals_project_id_number_key";
ALTER INDEX "cycle_capacities_pkey" RENAME TO "interval_capacities_pkey";
ALTER INDEX "cycle_capacities_cycle_id_user_id_key" RENAME TO "interval_capacities_interval_id_user_id_key";

-- 6. Foreign-key constraints
ALTER TABLE "intervals" RENAME CONSTRAINT "cycles_org_id_fkey" TO "intervals_org_id_fkey";
ALTER TABLE "intervals" RENAME CONSTRAINT "cycles_parent_id_fkey" TO "intervals_parent_id_fkey";
ALTER TABLE "intervals" RENAME CONSTRAINT "cycles_project_id_fkey" TO "intervals_project_id_fkey";
ALTER TABLE "interval_capacities" RENAME CONSTRAINT "cycle_capacities_cycle_id_fkey" TO "interval_capacities_interval_id_fkey";
ALTER TABLE "interval_capacities" RENAME CONSTRAINT "cycle_capacities_user_id_fkey" TO "interval_capacities_user_id_fkey";
ALTER TABLE "work_items" RENAME CONSTRAINT "work_items_cycle_id_fkey" TO "work_items_interval_id_fkey";
