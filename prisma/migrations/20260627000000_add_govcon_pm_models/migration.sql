-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'IN_GOVT_REVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BlockerType" AS ENUM ('INTERNAL', 'EXTERNAL_GOVERNMENT', 'EXTERNAL_VENDOR');

-- CreateEnum
CREATE TYPE "BlockerStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'IMPLEMENTED');

-- CreateTable
CREATE TABLE "risks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "branch" TEXT,
    "likelihood" INTEGER NOT NULL DEFAULT 1,
    "impact" INTEGER NOT NULL DEFAULT 1,
    "score" INTEGER NOT NULL DEFAULT 1,
    "level" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "owner" TEXT,
    "mitigation" TEXT,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "trend" TEXT,
    "escalate" BOOLEAN NOT NULL DEFAULT false,
    "target_date" TIMESTAMP(3),
    "classification" "ClassificationLevel" NOT NULL DEFAULT 'CUI',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "clin" TEXT,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "baseline_due" TIMESTAMP(3),
    "actual_submission" TIMESTAMP(3),
    "gov_acceptance" TIMESTAMP(3),
    "owner" TEXT,
    "revision_cycle" INTEGER NOT NULL DEFAULT 0,
    "escalate" BOOLEAN NOT NULL DEFAULT false,
    "classification" "ClassificationLevel" NOT NULL DEFAULT 'CUI',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "BlockerType" NOT NULL DEFAULT 'INTERNAL',
    "status" "BlockerStatus" NOT NULL DEFAULT 'OPEN',
    "what_unblocks" TEXT,
    "owner" TEXT,
    "customer_notified" BOOLEAN NOT NULL DEFAULT false,
    "escalate" BOOLEAN NOT NULL DEFAULT false,
    "identified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "classification" "ClassificationLevel" NOT NULL DEFAULT 'CUI',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blockers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "cost_impact" DECIMAL(14,2),
    "schedule_days_impact" INTEGER,
    "mod_required" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMP(3),
    "classification" "ClassificationLevel" NOT NULL DEFAULT 'CUI',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risks_org_id_project_id_status_idx" ON "risks"("org_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "risks_org_id_code_key" ON "risks"("org_id", "code");

-- CreateIndex
CREATE INDEX "deliverables_org_id_project_id_status_idx" ON "deliverables"("org_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deliverables_org_id_code_key" ON "deliverables"("org_id", "code");

-- CreateIndex
CREATE INDEX "blockers_org_id_project_id_status_idx" ON "blockers"("org_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "blockers_org_id_code_key" ON "blockers"("org_id", "code");

-- CreateIndex
CREATE INDEX "change_requests_org_id_project_id_status_idx" ON "change_requests"("org_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_org_id_code_key" ON "change_requests"("org_id", "code");

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

