-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_id" UUID,
ADD COLUMN     "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "expenses_org_id_status_idx" ON "expenses"("org_id", "status");

-- Backfill: grandfather every pre-existing expense as already-approved
-- (they were created as final ledger entries before the approval concept;
-- dropping them into DRAFT would hide all historical expenses behind a gate).
UPDATE "expenses" SET "status" = 'APPROVED', "approved_at" = "created_at" WHERE "status" = 'DRAFT';
