-- Archive a work item: out of the way, not destroyed.
--
-- Nullable timestamp, no default, so every existing row is active — which is
-- the correct pre-migration state and makes the column add metadata-only (no
-- table rewrite).
--
-- A timestamp rather than a boolean because "when was this archived" is the
-- question asked when something turns out to have been put away by mistake,
-- and `archived_at IS NULL` filters exactly as cheaply as a flag would.
ALTER TABLE "work_items" ADD COLUMN "archived_at" TIMESTAMP(3);

-- Every list query now carries `archived_at IS NULL`, alongside the org and
-- project scoping it already had. A partial index on the ACTIVE rows keeps that
-- predicate free: it indexes only the rows queries actually ask for, so it stays
-- small even in an org that archives heavily, and it is the shape Postgres can
-- use for the common `org + active` scan.
CREATE INDEX "work_items_org_id_active_idx"
  ON "work_items" ("org_id") WHERE "archived_at" IS NULL;
