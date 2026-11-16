-- Validate work_items_assignee_id_fkey, which 20261116120000 added NOT VALID
-- and then cleared every row that would fail it (an assignee that is no user).
-- From here the key is fully trusted: every row has been checked once, and
-- every write since is checked as it happens.
--
-- Its own migration, so the cleanup above has committed before this scan
-- starts. VALIDATE takes SHARE UPDATE EXCLUSIVE on work_items, so it doesn't
-- block reads or writes while it scans. If a row still fails (one imported
-- with triggers off, say, between the two), the deploy stops here and says so;
-- clear that row as 20261116120000 did and deploy again.
--
-- One DO block; guarded on convalidated, so a re-run is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'work_items_assignee_id_fkey' AND conrelid = 'work_items'::regclass AND NOT convalidated
    ) THEN
        ALTER TABLE "work_items" VALIDATE CONSTRAINT "work_items_assignee_id_fkey";
    END IF;
END $$;
