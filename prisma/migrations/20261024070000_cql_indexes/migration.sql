-- CQL phase 4 (query design §6.7): indexes for history (WAS / CHANGED), labels,
-- custom fields, title search and the scoped sorts the query language makes common.
-- Additive only. Declared in schema.prisma, so `migrate diff` shows no drift for them.
--
-- CONCURRENTLY, so building them on a populated database doesn't block writes
-- to work_items / activities. `prisma migrate deploy` runs a migration's
-- statements outside a transaction (verified: two CONCURRENTLY statements in
-- one file apply and both indexes come out valid), which CONCURRENTLY needs.
-- IF NOT EXISTS makes a re-run after an interrupted build skip what's done; an
-- index left INVALID by an interrupted build must be dropped by hand first
-- (`DROP INDEX CONCURRENTLY "<name>"`), then `prisma migrate resolve --rolled-back`
-- and deploy again.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_work_item_id_field_created_at_idx" ON "activities"("work_item_id", "field", "created_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_org_id_field_created_at_idx" ON "activities"("org_id", "field", "created_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_org_id_field_new_value_created_at_idx" ON "activities"("org_id", "field", "new_value", "created_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "milestone_links_work_item_id_idx" ON "milestone_links"("work_item_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_item_links_org_id_target_item_id_idx" ON "work_item_links"("org_id", "target_item_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_tags_idx" ON "work_items" USING GIN ("tags");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_custom_fields_idx" ON "work_items" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_title_idx" ON "work_items" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_org_id_project_id_updated_at_idx" ON "work_items"("org_id", "project_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_org_id_due_date_idx" ON "work_items"("org_id", "due_date");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_org_id_created_by_id_idx" ON "work_items"("org_id", "created_by_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "work_items_parent_id_idx" ON "work_items"("parent_id");
