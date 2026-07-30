-- Teams as a first-class CORE concept, plus opt-in project read scoping.
--
-- org -> projects -> teams -> members becomes the source of truth for who works
-- on what. The PI Planning plugin maps its PiPlanningTeam onto these rather than
-- keeping a second registry; direction of dependency is plugin -> core.
--
-- WHY THE NEW COLUMN DEFAULTS TO FALSE, and why that is the whole safety story:
--
-- Before this, `project_members` was a roster with no bearing on visibility —
-- 46 routes under projects/[projectId] gated reads on the org-wide permission
-- bitmask alone, so any org MEMBER read every project. Making membership
-- REQUIRED everywhere would be the "correct" model and a serious outage: every
-- existing org would instantly lose sight of projects its people use daily,
-- because nobody has been maintaining project_members as an access list.
--
-- So narrowing is opt-in per project. Every existing row gets false and behaves
-- exactly as it does today; a project only narrows once someone sets it true.
-- src/lib/rbac/project-access.ts short-circuits on that flag before doing any
-- membership work, so the common path is also the cheap one.

ALTER TABLE "projects"
  ADD COLUMN "team_scoped_access" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "teams" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"     UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "name"       TEXT NOT NULL,
  -- Short display code (e.g. "PLT-1"). Teams are identified by name; this is
  -- nullable so a team can exist before anyone decides on a code.
  "key"        TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- org_id is carried on the row (not just reachable via project) so tenant
-- scoping is a single predicate on every query, matching how the rest of the
-- schema is queried and keeping a cross-tenant read from needing a join.
CREATE UNIQUE INDEX "teams_project_id_name_key" ON "teams" ("project_id", "name");
CREATE INDEX "teams_org_id_idx" ON "teams" ("org_id");

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_org_id_fkey" FOREIGN KEY ("org_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "teams_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Membership points at project_members, NOT org_members or users.
--
-- That is the load-bearing choice here: you cannot be on a project's team
-- without being on the project, and removing someone from the project removes
-- them from its teams via ON DELETE CASCADE. The invariant is enforced by the
-- FK rather than by every call site remembering to check it — which matters
-- because this table is about to gate who can see what.
CREATE TABLE "team_members" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID NOT NULL,
  "project_member_id" UUID NOT NULL,
  -- Team lead. Distinct from project_members.role = 'MANAGER', which is
  -- project-wide; a team lead leads one team.
  "is_lead"           BOOLEAN NOT NULL DEFAULT false,
  "joined_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_members_team_id_project_member_id_key"
  ON "team_members" ("team_id", "project_member_id");

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id")
    REFERENCES "teams" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "team_members_project_member_id_fkey" FOREIGN KEY ("project_member_id")
    REFERENCES "project_members" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
