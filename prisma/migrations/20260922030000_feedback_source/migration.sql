-- Where a piece of feedback was raised.
--
-- Everything raised from a guided walkthrough used to land in the queue with
-- its tour and step written into the DESCRIPTION TEXT — readable, but not
-- filterable. Under a weekly release cadence where the walkthrough is the
-- channel people comment through, "show me what came back from this release"
-- is the question the queue exists to answer, and prose is the wrong place to
-- keep the answer.
--
-- Existing rows default to 'app', which is true of every row written before
-- this: the walkthrough path is the only other writer and it did not exist.
ALTER TABLE "feedback_items"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'app',
  ADD COLUMN "source_ref" TEXT;

CREATE INDEX "feedback_items_org_id_source_source_ref_idx"
  ON "feedback_items" ("org_id", "source", "source_ref");
