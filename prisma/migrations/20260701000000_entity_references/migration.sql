-- @-mention backlinks index: polymorphic (source references target), org-scoped,
-- no FKs (target/source span many tables). Additive; nothing else changes.
CREATE TABLE "entity_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_references_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entity_references_src_tgt_key" ON "entity_references"("source_type", "source_id", "target_type", "target_id");
CREATE INDEX "entity_references_org_target_idx" ON "entity_references"("org_id", "target_type", "target_id");
CREATE INDEX "entity_references_source_idx" ON "entity_references"("source_type", "source_id");
