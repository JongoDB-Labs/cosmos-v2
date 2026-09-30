-- weekly_report_entries.project_phase_id becomes a real reference.
--
-- It was a bare uuid because the phase it names belonged to a plugin, and a
-- plugin may not constrain a core table. ProjectPhase is core now, so it can be
-- said properly.
--
-- ON DELETE SET NULL, not CASCADE, and the distinction is the whole point:
-- retiring a phase must not delete a week that has already been reported. The
-- entry captures phase_name and phase_lifecycle at write, so it still reads
-- correctly once the reference is gone.
--
-- Checked against the reference deployment first: the table holds no rows, and
-- no row anywhere names a phase that does not exist.

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_report_entries_project_phase_id_fkey') THEN
    ALTER TABLE "weekly_report_entries" ADD CONSTRAINT "weekly_report_entries_project_phase_id_fkey" FOREIGN KEY ("project_phase_id") REFERENCES "project_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
