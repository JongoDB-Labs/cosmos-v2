-- COSMOS-204: a work item can sit with a team, separately from its assignee,
-- so a story can belong to a team before anyone on it picks it up.
--
-- NULL means "no team". Every existing row starts there, so the nullable column
-- needs no backfill. ON DELETE SET NULL: deleting a team leaves its work in place,
-- just unassigned from the team.
ALTER TABLE "work_items" ADD COLUMN "team_id" UUID;

ALTER TABLE "work_items" ADD CONSTRAINT "work_items_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The board team filter reads "this project's items for team X".
CREATE INDEX "work_items_project_id_team_id_idx" ON "work_items"("project_id", "team_id");
