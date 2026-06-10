-- Feedback attachments + auto-telemetry on bug reports (FR). Additive.
ALTER TABLE "feedback_items" ADD COLUMN "telemetry" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "feedback_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "feedback_item_id" UUID,
    "org_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_attachments_feedback_item_id_idx" ON "feedback_attachments"("feedback_item_id");
CREATE INDEX "feedback_attachments_uploaded_by_id_created_at_idx" ON "feedback_attachments"("uploaded_by_id", "created_at");

ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_feedback_item_id_fkey"
    FOREIGN KEY ("feedback_item_id") REFERENCES "feedback_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
