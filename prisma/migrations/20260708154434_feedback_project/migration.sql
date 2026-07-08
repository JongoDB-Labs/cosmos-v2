-- Multi-project feedback automation: tag a feedback item with the project its
-- triage should route to. Nullable + SetNull — deleting a project must not
-- cascade-delete feedback.

-- AlterTable
ALTER TABLE "feedback_items" ADD COLUMN     "project_id" UUID;

-- CreateIndex
CREATE INDEX "feedback_items_org_id_project_id_idx" ON "feedback_items"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
