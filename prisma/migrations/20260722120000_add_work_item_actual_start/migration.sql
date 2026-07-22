-- Unified item date model — add the single new column, WorkItem.actualStart
-- (Actual Start). Nullable; auto-captured going forward on the first in-progress
-- transition. Best-effort backfill: for items that already left the not-started
-- columns, seed actual_start from column_entered_at (the closest available signal).
-- No existing date is touched.
ALTER TABLE "work_items" ADD COLUMN "actual_start" TIMESTAMP(3);

UPDATE "work_items"
   SET "actual_start" = "column_entered_at"
 WHERE "actual_start" IS NULL
   AND "column_entered_at" IS NOT NULL
   AND lower("column_key") NOT IN ('backlog', 'todo', 'to-do');
