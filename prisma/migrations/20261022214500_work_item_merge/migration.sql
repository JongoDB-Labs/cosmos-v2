-- COSMOS-207: merge a duplicate into the item that survives. The merged-away
-- row is kept (Cancelled, reason MERGED) and points at its survivor; deleting
-- the survivor leaves the pointer NULL rather than deleting the history.
ALTER TYPE "CancelReason" ADD VALUE 'MERGED';

ALTER TABLE "work_items" ADD COLUMN "merged_into_id" UUID;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
