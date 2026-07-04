-- Manual display order for objectives within a project (drag-to-reorder on the
-- Objectives tab). Default 0; backfilled below so existing lists keep their order.
ALTER TABLE "objectives" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Seed the order from existing creation order, per project, so the current list
-- ordering is preserved as the initial manual order (0, 1, 2, … within a project).
UPDATE "objectives" o
SET "sort_order" = seq.rn
FROM (
  SELECT id,
         (ROW_NUMBER() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") - 1) AS rn
  FROM "objectives"
) seq
WHERE o.id = seq.id;
