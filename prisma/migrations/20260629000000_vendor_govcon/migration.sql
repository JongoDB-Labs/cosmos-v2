-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "cage_code" TEXT,
ADD COLUMN     "perf_rating" INTEGER,
ADD COLUMN     "socio_economic" TEXT;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "project_id" UUID;

-- CreateIndex
CREATE INDEX "contracts_org_id_project_id_idx" ON "contracts"("org_id", "project_id");

