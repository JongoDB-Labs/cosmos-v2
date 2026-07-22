-- Retire the manual-baseline columns now that schedule health derives inherently
-- from Actual vs current Projected End. No user-visible date is lost: planned dates
-- remain in work_items.start_date/due_date; milestone/deliverable actuals in
-- actual_date/actual_submission. milestones.projected_date was dead (never written).
ALTER TABLE "work_items" DROP COLUMN "baseline_start";
ALTER TABLE "work_items" DROP COLUMN "baseline_end";
ALTER TABLE "milestones" DROP COLUMN "baseline_date";
ALTER TABLE "milestones" DROP COLUMN "projected_date";
