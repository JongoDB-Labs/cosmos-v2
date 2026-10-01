-- Drop the unused work_item_attachments table.
--
-- It was created by a prod-parity migration and NO code has ever read or written
-- it: a url and an externalRef with no storageKey, so it could only ever point at
-- a file living in another tracker, and no uploadedById, so it could not say who
-- put it there. Attachments are now documents in the project library carrying the
-- item's id (2.422.0), which gives one storage path, one serving policy and one
-- record of who added what.
--
-- Guarded, not blind. A table with rows in it is somebody's data even if no code
-- reads it, so this REFUSES rather than destroying: the exception names the count
-- and the migration stops, which is recoverable. A silent drop is not.
DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'work_item_attachments'
  ) THEN
    EXECUTE 'SELECT count(*) FROM "work_item_attachments"' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'work_item_attachments holds % row(s); refusing to drop. Migrate them to documents (work_item_id) first, then re-run.', n;
    END IF;
    DROP TABLE "work_item_attachments";
  END IF;
END $$;
