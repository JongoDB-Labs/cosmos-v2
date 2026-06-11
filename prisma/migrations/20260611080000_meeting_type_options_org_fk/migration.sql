-- The original meeting_type_options table (20260610190000) created org_id as a
-- bare column with no foreign key, so deleting an org would leave orphaned
-- meeting-type rows scoped to a now-nonexistent org. Add the missing FK so org
-- deletion cascades, matching every other org-scoped child table.
--
-- Additive + idempotent: guarded by a NOT-EXISTS check so a re-run (or an
-- environment that somehow already has it) is a no-op rather than an error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meeting_type_options_org_id_fkey'
  ) THEN
    ALTER TABLE "meeting_type_options"
      ADD CONSTRAINT "meeting_type_options_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
