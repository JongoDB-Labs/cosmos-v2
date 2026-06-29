-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "subject_id" UUID,
ADD COLUMN     "subject_type" TEXT,
ALTER COLUMN "work_item_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "subject_id" UUID,
ADD COLUMN     "subject_type" TEXT,
ALTER COLUMN "work_item_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "activities_org_id_subject_type_subject_id_idx" ON "activities"("org_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "comments_org_id_subject_type_subject_id_idx" ON "comments"("org_id", "subject_type", "subject_id");

