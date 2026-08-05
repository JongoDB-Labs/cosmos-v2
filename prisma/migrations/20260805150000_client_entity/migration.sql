-- A client the practice DELIVERS for, and a project's reference to one.
--
-- Until now a project's client was a string parked in `settings.clientName` by
-- the import, which meant it could not be filtered, renamed in one place, or
-- pointed at by anything else. CrmContact was not the answer: that is a sales
-- PROSPECT carrying a pipeline stage and a deal value, and reusing it would put
-- won work back on the pipeline board.

CREATE TABLE "clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "clients_org_id_active_idx" ON "clients"("org_id", "active");
CREATE UNIQUE INDEX "clients_org_id_name_key" ON "clients"("org_id", "name");
ALTER TABLE "clients" ADD CONSTRAINT "clients_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects" ADD COLUMN "client_id" UUID;
-- SetNull, not Cascade: removing a client must never delete the work done for
-- them.
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Promote the flat text into real rows, per org, trimming and collapsing
-- whitespace so "Build AC" and "Build  AC " do not become two clients. Names
-- are compared case-insensitively for the same reason; the first spelling seen
-- wins, which is arbitrary but stable.
INSERT INTO "clients" ("org_id", "name", "updated_at")
SELECT DISTINCT ON (p.org_id, lower(regexp_replace(btrim(p.settings->>'clientName'), '\s+', ' ', 'g')))
       p.org_id,
       regexp_replace(btrim(p.settings->>'clientName'), '\s+', ' ', 'g'),
       now()
FROM "projects" p
WHERE p.settings->>'clientName' IS NOT NULL
  AND btrim(p.settings->>'clientName') <> ''
ORDER BY p.org_id,
         lower(regexp_replace(btrim(p.settings->>'clientName'), '\s+', ' ', 'g')),
         p.created_at;

UPDATE "projects" p SET "client_id" = c."id"
FROM "clients" c
WHERE c."org_id" = p."org_id"
  AND lower(c."name") = lower(regexp_replace(btrim(p.settings->>'clientName'), '\s+', ' ', 'g'))
  AND p."client_id" IS NULL;

-- `settings.clientName` is deliberately LEFT IN PLACE. It is what the importer
-- writes and what a re-run would rewrite; dropping it here would make the next
-- import silently disagree with the FK. The reader prefers the relation, and
-- the importer is what should stop writing the string.
DO $verify$
DECLARE named int; linked int;
BEGIN
  SELECT count(*) INTO named FROM "projects"
   WHERE settings->>'clientName' IS NOT NULL AND btrim(settings->>'clientName') <> '';
  SELECT count(*) INTO linked FROM "projects" WHERE "client_id" IS NOT NULL;
  RAISE NOTICE 'projects naming a client: %, now linked: %', named, linked;
  IF linked <> named THEN
    RAISE EXCEPTION 'client backfill missed % project(s)', named - linked;
  END IF;
END $verify$;
