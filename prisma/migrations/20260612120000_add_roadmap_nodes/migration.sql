-- Roadmap nodes — project-scoped reference surface (sections, sub-phases, LOEs,
-- risks, decisions, stakeholders, milestones) rendered as navigable, deep-linkable
-- nodes so issue descriptions can cite a node as source-of-truth. ADDITIVE ONLY:
-- one new enum + one new table + indexes + FKs (incl. a self-FK for the hierarchy).
--
-- Hand-authored (NOT a raw `prisma migrate diff`, which would try to "correct" the
-- repo's intentional drift: pgvector embedding indexes, content_tsv generated col,
-- audit-chain sequences/triggers). cosmos_app gets access to the new public table
-- via the default privileges set at DB init (no explicit GRANT needed).

-- CreateEnum
CREATE TYPE "RoadmapNodeKind" AS ENUM ('SECTION', 'SUBPHASE', 'LOE', 'RISK', 'DECISION', 'STAKEHOLDER', 'MILESTONE');

-- CreateTable
CREATE TABLE "roadmap_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "RoadmapNodeKind" NOT NULL,
    "external_ref" TEXT,
    "section" TEXT,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "anchor" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "parent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_nodes_org_id_project_id_external_ref_key" ON "roadmap_nodes"("org_id", "project_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_nodes_org_id_project_id_anchor_key" ON "roadmap_nodes"("org_id", "project_id", "anchor");

-- CreateIndex
CREATE INDEX "roadmap_nodes_org_id_project_id_idx" ON "roadmap_nodes"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "roadmap_nodes_org_id_project_id_kind_idx" ON "roadmap_nodes"("org_id", "project_id", "kind");

-- CreateIndex
CREATE INDEX "roadmap_nodes_parent_id_idx" ON "roadmap_nodes"("parent_id");

-- AddForeignKey
ALTER TABLE "roadmap_nodes" ADD CONSTRAINT "roadmap_nodes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_nodes" ADD CONSTRAINT "roadmap_nodes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (self-relation; SetNull mirrors work_items_parent_id_fkey)
ALTER TABLE "roadmap_nodes" ADD CONSTRAINT "roadmap_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "roadmap_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
