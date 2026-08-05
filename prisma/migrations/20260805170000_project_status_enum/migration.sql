-- A project's lifecycle state, promoted from `settings.status` to a real column.
--
-- The JSON form accepted whatever the caller sent. The only thing constraining
-- it was a hardcoded list in one dropdown, so nothing stopped a second caller
-- writing "Active", "active" or "in progress" alongside it, and nothing could
-- filter or group on the result.
--
-- No ARCHIVED member: archival is already `projects.archived`, which drives list
-- filtering across core. Two fields able to disagree about the same fact is what
-- this migration exists to remove, not to reintroduce one level down.

CREATE TYPE "project_status" AS ENUM ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETE');

ALTER TABLE "projects" ADD COLUMN "status" "project_status" NOT NULL DEFAULT 'ACTIVE';

-- Backfill from the JSON. Case- and separator-insensitive because the column it
-- is reading was never constrained: "on hold", "On-Hold" and "ON_HOLD" all mean
-- the same thing and all could be sitting there.
UPDATE "projects" SET "status" =
  CASE upper(regexp_replace(btrim("settings"->>'status'), '[\s-]+', '_', 'g'))
    WHEN 'DRAFT'       THEN 'DRAFT'::"project_status"
    WHEN 'ON_HOLD'     THEN 'ON_HOLD'::"project_status"
    WHEN 'HOLD'        THEN 'ON_HOLD'::"project_status"
    WHEN 'INACTIVE'    THEN 'ON_HOLD'::"project_status"
    WHEN 'COMPLETE'    THEN 'COMPLETE'::"project_status"
    WHEN 'COMPLETED'   THEN 'COMPLETE'::"project_status"
    WHEN 'DONE'        THEN 'COMPLETE'::"project_status"
    -- Anything else, including 'ARCHIVED' and any spelling nobody anticipated,
    -- lands on ACTIVE — which is exactly what the previous reader defaulted to,
    -- so no project's displayed status changes as a result of this migration.
    -- An ARCHIVED one already carries archived = true and stays out of the lists
    -- on that basis.
    ELSE 'ACTIVE'::"project_status"
  END
WHERE "settings"->>'status' IS NOT NULL;

-- Now drop the key, so there is ONE answer. Unlike settings.clientName (left in
-- place because the importer rewrites it), nothing writes settings.status except
-- the UI this change updates, so removing it cannot desync anything.
UPDATE "projects" SET "settings" = "settings" - 'status'
WHERE "settings" ? 'status';

DO $verify$
DECLARE
  leftover INT;
BEGIN
  SELECT count(*) INTO leftover FROM "projects" WHERE "settings" ? 'status';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'project status migration left % row(s) with settings.status', leftover;
  END IF;
END
$verify$;

CREATE INDEX "projects_org_id_status_idx" ON "projects"("org_id", "status");
