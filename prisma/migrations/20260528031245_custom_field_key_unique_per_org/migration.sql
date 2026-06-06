-- Tighten custom field key uniqueness from (org, project, key) to (org, key).
-- Resolve any existing duplicates by suffixing later rows with their short id,
-- so the new unique index can be created without data loss.

WITH ranked AS (
  SELECT
    "id",
    "key",
    ROW_NUMBER() OVER (
      PARTITION BY "org_id", "key"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "public"."custom_fields"
)
UPDATE "public"."custom_fields" cf
SET "key" = cf."key" || '_' || substr(cf."id"::text, 1, 8)
FROM ranked
WHERE cf."id" = ranked."id"
  AND ranked.rn > 1;

-- Drop the old composite unique index
DROP INDEX IF EXISTS "public"."custom_fields_org_id_project_id_key_key";

-- Create the new tighter unique index
CREATE UNIQUE INDEX "custom_fields_org_id_key_key" ON "public"."custom_fields"("org_id" ASC, "key" ASC);
