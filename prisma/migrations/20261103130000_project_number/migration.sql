-- Project numbers: an org-wide standard such as YY-NNN that new projects are
-- numbered from (src/lib/projects/numbering.ts). Separate from `key`, which
-- prefixes ticket ids.
--
-- Nullable, no default: existing projects are simply unnumbered. Unique per
-- org; Postgres treats NULLs as distinct, so every unnumbered project
-- coexists, which is exactly the intent.
--
-- Safe to re-run.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "number" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_org_id_number_key" ON "projects"("org_id", "number");
