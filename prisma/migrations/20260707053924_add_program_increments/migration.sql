-- Program Increment (PI) hierarchy (SAFe): PROGRAM_INCREMENT cycle kind + a
-- self-referential parent so a PI cycle can contain sprint cycles.

-- AlterEnum
ALTER TYPE "CycleKind" ADD VALUE 'PROGRAM_INCREMENT';

-- AlterTable
ALTER TABLE "cycles" ADD COLUMN     "parent_id" UUID;

-- CreateIndex
CREATE INDEX "cycles_parent_id_idx" ON "cycles"("parent_id");

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
