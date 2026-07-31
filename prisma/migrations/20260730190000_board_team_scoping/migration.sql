-- A board may belong to a TEAM within its project.
--
-- #35 asked for "a member sees their own team's board(s) by default, plus other
-- teams' resources as RBAC allows". teamScopedAccess answered the coarse half —
-- who can see the PROJECT. This is the finer half: within a project everyone can
-- see, which boards are a given team's.
--
-- NULLABLE, and null on every existing row, deliberately. Null means "the whole
-- project shares this board", which is exactly today's behaviour, so nothing
-- narrows until someone assigns a board to a team. Same opt-in shape as
-- team_scoped_access, and for the same reason: the two access-control changes
-- before it that narrowed by default both caused incidents.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a team must not delete its
-- boards, and must not leave them invisible either. They fall back to being
-- shared with the project, which is recoverable and obvious. Cascade here would
-- destroy work as a side effect of tidying up a roster.
ALTER TABLE "boards" ADD COLUMN "team_id" UUID;

ALTER TABLE "boards"
  ADD CONSTRAINT "boards_team_id_fkey" FOREIGN KEY ("team_id")
    REFERENCES "teams" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Filtering is always "team_id IS NULL OR team_id = ANY(my teams)", so the
-- index carries the project too — the query is never for a bare team.
CREATE INDEX "boards_project_id_team_id_idx" ON "boards" ("project_id", "team_id");
