-- Workflow P2: CUSTOM workflows, their immutable versions, and which one governs
-- each (project x work-item type). A project or type with no assignment runs the
-- open workflow generated from its statuses, so nothing is backfilled.

-- CreateEnum
CREATE TYPE "workflow_enforcement" AS ENUM ('SHADOW', 'ENFORCE');

-- CreateEnum
CREATE TYPE "workflow_version_state" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enforcement" "workflow_enforcement" NOT NULL DEFAULT 'ENFORCE',
    "published_version_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "workflow_version_state" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "checksum" TEXT NOT NULL,
    "migration_map" JSONB,
    "published_by_id" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "work_item_type_id" UUID,
    "workflow_id" UUID NOT NULL,
    "migration_map" JSONB,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflows_published_version_id_key" ON "workflows"("published_version_id");

-- CreateIndex
CREATE INDEX "workflows_org_id_idx" ON "workflows"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_project_id_name_key" ON "workflows"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_key" ON "workflow_versions"("workflow_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_assignments_project_id_work_item_type_id_key" ON "workflow_assignments"("project_id", "work_item_type_id");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_work_item_type_id_fkey" FOREIGN KEY ("work_item_type_id") REFERENCES "work_item_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One project default per project: the composite unique above treats NULL
-- type ids as distinct.
CREATE UNIQUE INDEX "workflow_assignments_project_default_key" ON "workflow_assignments"("project_id") WHERE "work_item_type_id" IS NULL;

-- One org template per name: (project_id, name) above treats the NULL project
-- id of a template as distinct, so two templates could share a name.
CREATE UNIQUE INDEX "workflows_org_template_name_key" ON "workflows"("org_id", "name") WHERE "project_id" IS NULL;
