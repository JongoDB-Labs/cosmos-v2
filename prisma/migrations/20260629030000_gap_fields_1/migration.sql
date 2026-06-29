-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "nda_expiry" TIMESTAMP(3),
ADD COLUMN     "nda_on_file" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "poc_email" TEXT,
ADD COLUMN     "poc_name" TEXT;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "agmt_number" TEXT,
ADD COLUMN     "agmt_type" TEXT,
ADD COLUMN     "funded_value" DECIMAL(19,4),
ADD COLUMN     "invoiced_value" DECIMAL(19,4),
ADD COLUMN     "payment_terms" TEXT;

-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "downstream_impact" TEXT,
ADD COLUMN     "milestone_type" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "related_ref" TEXT;

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "branch_owner" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "work_item_ref" TEXT;

-- AlterTable
ALTER TABLE "blockers" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "related_ref" TEXT;

-- AlterTable
ALTER TABLE "change_requests" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "scope_impact" TEXT,
ADD COLUMN     "submitted_date" TIMESTAMP(3);

