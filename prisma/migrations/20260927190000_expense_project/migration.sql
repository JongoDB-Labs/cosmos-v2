-- An expense can belong to a project.
--
-- Nullable: plenty of costs are the firm's rather than a job's, and forcing
-- those onto a project would be a worse lie than leaving them unattributed.
-- SET NULL on delete for the same reason — losing the project must not take
-- the cost with it.

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "project_id" UUID;

-- CreateIndex
CREATE INDEX "expenses_org_id_project_id_idx" ON "expenses"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

