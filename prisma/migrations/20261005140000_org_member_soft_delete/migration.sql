-- Retain the membership row when someone is removed from an org, so their
-- history stays attributable and the rows that cascade from it
-- (project_members, org_member_work_roles) survive the removal.
--
-- NULL means "currently a member". Existing rows are all current members, so the
-- nullable column needs no backfill.
ALTER TABLE "org_members" ADD COLUMN "removed_at" TIMESTAMP(3);

-- Reads filter on (org_id, removed_at) — see the client extension in
-- src/lib/db/client.ts, which injects `removed_at IS NULL` by default.
CREATE INDEX "org_members_org_id_removed_at_idx" ON "org_members"("org_id", "removed_at");
