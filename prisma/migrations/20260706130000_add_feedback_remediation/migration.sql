-- Auto-remediation loop (FR 695aa097): deliver OPEN feedback into the work
-- backlog. All additive + nullable; an un-delivered item has all three null.

-- AlterTable
ALTER TABLE "feedback_items"
  ADD COLUMN "delivered_at" TIMESTAMP(3),
  ADD COLUMN "work_item_id" UUID,
  ADD COLUMN "triage" JSONB;

-- CreateIndex: backs the poller's "OPEN + not yet delivered" scan.
CREATE INDEX "feedback_items_org_id_delivered_at_idx" ON "feedback_items"("org_id", "delivered_at");
