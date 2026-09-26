-- Where a project came from, in the system it came from.
--
-- A Monograph project number, a JIRA key, an ERP code. Null for anything
-- created in Cosmos itself, which is why the column is nullable and the unique
-- index below tolerates many nulls.
--
-- This is the key a RE-import matches on. Names get edited and project keys get
-- reused, but the source system's own id stays put — so next week's export
-- updates the same rows rather than forking a second copy of every project.
ALTER TABLE "projects" ADD COLUMN "external_ref" TEXT;

-- Unique per org. Postgres treats NULLs as distinct in a unique index, so every
-- hand-created project (external_ref IS NULL) coexists freely; only two rows
-- claiming the SAME source id collide, which is exactly the mistake worth
-- refusing.
CREATE UNIQUE INDEX "projects_org_id_external_ref_key"
  ON "projects" ("org_id", "external_ref");
