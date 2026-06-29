-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeliverableStatus" ADD VALUE 'DRAFT_IN_PROGRESS';
ALTER TYPE "DeliverableStatus" ADD VALUE 'INTERNAL_REVIEW';
ALTER TYPE "DeliverableStatus" ADD VALUE 'ACCEPTED_WITH_COMMENTS';
ALTER TYPE "DeliverableStatus" ADD VALUE 'REVISION_REQUIRED';
ALTER TYPE "DeliverableStatus" ADD VALUE 'OVERDUE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BlockerType" ADD VALUE 'EXTERNAL_PROCUREMENT';
ALTER TYPE "BlockerType" ADD VALUE 'EXTERNAL_THIRD_PARTY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BlockerStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "BlockerStatus" ADD VALUE 'ESCALATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChangeRequestStatus" ADD VALUE 'UNDER_REVIEW';
ALTER TYPE "ChangeRequestStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "actual_date" TIMESTAMP(3),
ADD COLUMN     "baseline_date" TIMESTAMP(3),
ADD COLUMN     "phase" TEXT,
ADD COLUMN     "projected_date" TIMESTAMP(3),
ADD COLUMN     "recovery_plan" TEXT,
ADD COLUMN     "recovery_target" TIMESTAMP(3),
ADD COLUMN     "root_cause" TEXT,
ADD COLUMN     "schedule_escalate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "deliverable_type" TEXT,
ADD COLUMN     "gov_review_period" INTEGER,
ADD COLUMN     "internal_review" TIMESTAMP(3),
ADD COLUMN     "milestone_id" UUID,
ADD COLUMN     "rev_required" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "blockers" ADD COLUMN     "customer_notified_date" TIMESTAMP(3),
ADD COLUMN     "decision_authority" TEXT,
ADD COLUMN     "identified_by" TEXT,
ADD COLUMN     "related_risk_code" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "target_date" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "change_requests" ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "decision_authority" TEXT,
ADD COLUMN     "impl_date" TIMESTAMP(3),
ADD COLUMN     "initiatedBy" TEXT,
ADD COLUMN     "mod_number" TEXT,
ADD COLUMN     "related_risk_code" TEXT;

-- CreateTable
CREATE TABLE "deliverable_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "deliverable_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT,
    "date_returned" TIMESTAMP(3),
    "comment_summary" TEXT,
    "owner" TEXT,
    "revised_target" TIMESTAMP(3),
    "actual_revised" TIMESTAMP(3),
    "days_to_resolve" INTEGER,
    "gov_acceptance" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverable_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deliverable_revisions_org_id_deliverable_id_idx" ON "deliverable_revisions"("org_id", "deliverable_id");

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable_revisions" ADD CONSTRAINT "deliverable_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable_revisions" ADD CONSTRAINT "deliverable_revisions_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

