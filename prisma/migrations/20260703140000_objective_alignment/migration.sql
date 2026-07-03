-- OKR redesign P3: objective alignment (an objective ladders up to a parent
-- objective). Additive; nullable self-FK, SetNull on parent delete.

-- AlterTable
ALTER TABLE "objectives" ADD COLUMN "parent_objective_id" UUID;

-- CreateIndex
CREATE INDEX "objectives_parent_objective_id_idx" ON "objectives"("parent_objective_id");

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_parent_objective_id_fkey" FOREIGN KEY ("parent_objective_id") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;
