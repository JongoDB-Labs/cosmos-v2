-- Attach a library document to a work item.
--
-- Created idempotently: this column and its constraint may already exist on a
-- deployment where the schema was applied out of band, and a migration that fails
-- on second sight blocks every migration behind it.
--
-- ON DELETE SET NULL, deliberately. Cascade would mean deleting a ticket deletes
-- the files people attached to it; the document belongs to the project as well, so
-- detaching is both safe and the only choice that cannot destroy somebody's work.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "work_item_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_work_item_id_fkey'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_work_item_id_fkey"
      FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "documents_org_id_work_item_id_idx"
  ON "documents" ("org_id", "work_item_id");
