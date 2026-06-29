-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "clin_id" UUID;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "clin_id" UUID;

-- CreateTable
CREATE TABLE "clins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "funded_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "pop_start" TIMESTAMP(3),
    "pop_end" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clins_org_id_project_id_idx" ON "clins"("org_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "clins_org_id_project_id_code_key" ON "clins"("org_id", "project_id", "code");

