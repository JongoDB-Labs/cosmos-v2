-- time_entry_phases.set_by_id becomes a real reference to a user.
--
-- It records who attributed an hour to a phase, so that "something inferred
-- this" and "a person decided this" stay distinguishable. It was a bare uuid
-- while this table belonged to a plugin, because a plugin may not constrain a
-- core table -- and one deployment accumulated 3,098 rows holding the zero
-- uuid, which resolves to nobody while reading as an actor to anything testing
-- the column for absence. The column therefore distinguished nothing.
--
-- The zero uuid is never a valid users.id, so normalising it to NULL loses no
-- information: NULL is the encoding the column already documented for "not a
-- person". Scoped to that ONE value on purpose. Any OTHER unresolvable value is
-- a different problem, and the foreign key below will refuse to apply rather
-- than let this migration quietly discard it.

UPDATE "time_entry_phases"
SET "set_by_id" = NULL
WHERE "set_by_id" = '00000000-0000-0000-0000-000000000000';

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entry_phases_set_by_id_fkey') THEN
    ALTER TABLE "time_entry_phases" ADD CONSTRAINT "time_entry_phases_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
