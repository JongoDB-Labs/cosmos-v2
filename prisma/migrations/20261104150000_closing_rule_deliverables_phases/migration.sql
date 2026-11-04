-- The closing rule for deliverables and phases (src/lib/pm/closing-evidence.ts).
--
--   1. documents gain deliverable_id and phase_id, as they already have
--      work_item_id: a file can be a deliverable's or a phase's supporting
--      evidence. ON DELETE SET NULL, matching work_item_id: removing the
--      record never deletes the file.
--   2. deliverables and project_phases gain close_evidence_note, the recorded
--      reason no file was needed.
--   3. project_phases gain closed_at / closed_by_id: a phase is closed by an
--      explicit action, never inferred from percent_complete.
--
-- All nullable with no default, so every existing row reads "not attached /
-- not closed / nothing recorded", which is what it was. Safe to re-run.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deliverable_id" UUID;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "phase_id" UUID;
ALTER TABLE "deliverables" ADD COLUMN IF NOT EXISTS "close_evidence_note" TEXT;
ALTER TABLE "project_phases" ADD COLUMN IF NOT EXISTS "close_evidence_note" TEXT;
ALTER TABLE "project_phases" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "project_phases" ADD COLUMN IF NOT EXISTS "closed_by_id" UUID;

CREATE INDEX IF NOT EXISTS "documents_deliverable_id_idx" ON "documents"("deliverable_id");
CREATE INDEX IF NOT EXISTS "documents_phase_id_idx" ON "documents"("phase_id");

DO $$
BEGIN
  ALTER TABLE "documents" ADD CONSTRAINT "documents_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "documents" ADD CONSTRAINT "documents_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "project_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
