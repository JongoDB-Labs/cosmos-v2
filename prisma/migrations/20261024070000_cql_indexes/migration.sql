-- CQL phase 4 (query design §6.7): indexes for history (WAS / CHANGED), labels,
-- custom fields, title search and the scoped sorts the query language makes common.
-- Additive only. Declared in schema.prisma, so `migrate diff` shows no drift for them.
--
-- CONCURRENTLY, so building them on a populated database doesn't block writes
-- to work_items / activities. `prisma migrate deploy` runs a migration's
-- statements outside a transaction (verified: two CONCURRENTLY statements in
-- one file apply and both indexes come out valid), which CONCURRENTLY needs.
--
-- No index here has a key that can outgrow a btree row (~2.7KB): activities'
-- old_value / new_value hold free text from the PM registers (a risk's
-- mitigation, uncapped), so they are filtered, never indexed. tags are label
-- names, which labels' own btree on lower(name) already bounds.
--
-- If a build is interrupted (a lost connection, a cancel), Postgres can leave
-- that index INVALID, and IF NOT EXISTS then SKIPS it on the next deploy: a
-- re-run alone never rebuilds it. The check at the end of this file therefore
-- fails the deploy while any of these indexes is missing or INVALID. To
-- recover: `DROP INDEX CONCURRENTLY "<the index it names>";`, then
-- `prisma migrate resolve --rolled-back 20261024070000_cql_indexes`, then
-- deploy again.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_work_item_id_field_created_at_idx" ON "activities"("work_item_id", "field", "created_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities_org_id_field_created_at_idx" ON "activities"("org_id", "field", "created_at");

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

-- Every index above exists and is VALID, or the deploy fails (see the header).
-- One plain statement on purpose: a dollar-quoted DO block makes Prisma send the
-- whole file as one transaction, and CONCURRENTLY can't run inside one
-- (tried: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block").
-- When something is wrong, the cast fails and its error message carries the
-- list: invalid input syntax for type integer: "CQL indexes missing or INVALID: …".
SELECT CASE WHEN bad IS NULL THEN 0
            ELSE ('CQL indexes missing or INVALID: ' || bad
                  || '. DROP INDEX CONCURRENTLY each one named, then migrate resolve --rolled-back 20261024070000_cql_indexes and deploy again.')::int
       END
  FROM (SELECT string_agg(n, ', ' ORDER BY n) AS bad
          FROM unnest(ARRAY['activities_work_item_id_field_created_at_idx', 'activities_org_id_field_created_at_idx', 'milestone_links_work_item_id_idx', 'work_item_links_org_id_target_item_id_idx', 'work_items_tags_idx', 'work_items_custom_fields_idx', 'work_items_title_idx', 'work_items_org_id_project_id_updated_at_idx', 'work_items_org_id_due_date_idx', 'work_items_org_id_created_by_id_idx', 'work_items_parent_id_idx']) AS n
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = n AND i.indisvalid AND i.indisready)) AS check_result;
