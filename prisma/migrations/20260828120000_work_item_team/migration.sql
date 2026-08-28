-- Team assignment on a work item (COSMOS-186 Phase 1).
--
-- Until now a team's tasking was DERIVED — it was whatever was assigned to that
-- team's people (see src/lib/teams/item-teams.ts). That could not express "this
-- is the platform team's, nobody has picked it up yet": an unassigned item
-- belonged to no team however obviously it was for one.
--
-- So the team is a first-class nullable reference, independent of assignee_id in
-- both directions. Additive and nullable, so every existing row keeps working
-- and the derived behaviour still applies to items that carry no explicit team.
--
-- ON DELETE SET NULL, not CASCADE: disbanding a team must not delete its work.
-- The items survive with no team, exactly as if they had never had one.

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "team_id" UUID;

-- CreateIndex
CREATE INDEX "work_items_org_id_team_id_idx" ON "work_items"("org_id", "team_id");

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
