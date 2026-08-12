-- Milestones move from Branches to Program Increments.
--
-- Dropped as dead: milestones.phase, milestone_type and related_ref were NULL on
-- every row in production and surfaced nowhere but the Schedule create/edit form.
--
-- Dropped as unfinishable: the whole program_branches taxonomy. Branches had no
-- CRUD UI and no API route — they only ever arrived by seed, so no user could
-- create, rename or delete one. The branch-scoped RBAC they fed was likewise
-- unreachable: OrgMemberWorkRole.scope is never written, so branchScopeWhere()
-- resolved to {} for everyone. LOE tagging on 5 milestones and 3 risks is
-- deliberately lost; the pre-migration pg_dump is the only record.
-- Note DROP COLUMN also drops each table's branch_id foreign key, so the five
-- constraints added in 20260627010000_add_program_branch need no explicit drop.
--
-- Added: milestones.interval_id, an optional link to a PROGRAM_INCREMENT interval.
-- Nothing is backfilled — no code ever associated a milestone with an interval,
-- even implicitly by date, so there is no mapping to preserve. Every milestone
-- starts unassigned. SET NULL so deleting a PI orphans its milestones rather than
-- deleting them, matching intervals.parent_id and objectives.interval_id.

-- AlterTable
ALTER TABLE "milestones" ADD COLUMN "interval_id" UUID;

-- CreateIndex
CREATE INDEX "milestones_interval_id_idx" ON "milestones"("interval_id");

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_interval_id_fkey" FOREIGN KEY ("interval_id") REFERENCES "intervals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "milestones" DROP COLUMN "phase";
ALTER TABLE "milestones" DROP COLUMN "milestone_type";
ALTER TABLE "milestones" DROP COLUMN "related_ref";

-- AlterTable
ALTER TABLE "milestones" DROP COLUMN "branch_id";
ALTER TABLE "risks" DROP COLUMN "branch_id";
ALTER TABLE "deliverables" DROP COLUMN "branch_id";
ALTER TABLE "deliverables" DROP COLUMN "branch_owner";
ALTER TABLE "blockers" DROP COLUMN "branch_id";
ALTER TABLE "change_requests" DROP COLUMN "branch_id";

-- DropTable
DROP TABLE "program_branches";
