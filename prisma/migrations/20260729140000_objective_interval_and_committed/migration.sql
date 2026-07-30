-- PI Objectives on the Goals board.
--
-- Two additions to `objectives`:
--
--   `interval_id` — the timebox this objective belongs to: a Program Increment
--   for a PI Objective, a sprint for a sprint-level one. ON DELETE SET NULL so
--   deleting a PI never destroys the objectives committed to it — they fall
--   back to untimeboxed, mirroring how a PI orphans (never deletes) its child
--   sprints.
--
--   `committed` — SAFe's committed vs uncommitted (stretch) distinction. NOT
--   NULL DEFAULT true, so every existing objective reads as a commitment:
--   these were all written before the distinction existed, and treating an
--   unqualified objective as a promise is the safe reading. Marking something
--   as stretch is then a deliberate act.
ALTER TABLE "objectives"
  ADD COLUMN "interval_id" UUID,
  ADD COLUMN "committed" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "objectives"
  ADD CONSTRAINT "objectives_interval_id_fkey"
  FOREIGN KEY ("interval_id") REFERENCES "intervals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "objectives_interval_id_idx" ON "objectives"("interval_id");
