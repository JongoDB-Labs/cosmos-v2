-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "branch_id" UUID;

-- AlterTable
ALTER TABLE "risks" ADD COLUMN     "branch_id" UUID;

-- AlterTable
ALTER TABLE "deliverables" ADD COLUMN     "branch_id" UUID;

-- AlterTable
ALTER TABLE "blockers" ADD COLUMN     "branch_id" UUID;

-- AlterTable
ALTER TABLE "change_requests" ADD COLUMN     "branch_id" UUID;

-- CreateTable
CREATE TABLE "program_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "program_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "program_branches_org_id_code_key" ON "program_branches"("org_id", "code");

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "program_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "program_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "program_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "program_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "program_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_branches" ADD CONSTRAINT "program_branches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

