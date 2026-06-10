-- Org-defined reusable meeting types extending the built-in MeetingType enum.
-- Additive only: a new table + a nullable FK column on sync_meetings, so
-- existing meetings are unaffected (custom_type_id stays NULL → built-in type).
-- Mirrors the feedback_attachments migration (no explicit GRANT — cosmos_app
-- receives access to new public tables via the default privileges set at init).

CREATE TABLE "meeting_type_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_type_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_type_options_org_id_label_key" ON "meeting_type_options"("org_id", "label");

CREATE INDEX "meeting_type_options_org_id_idx" ON "meeting_type_options"("org_id");

ALTER TABLE "sync_meetings" ADD COLUMN "custom_type_id" UUID;

ALTER TABLE "sync_meetings" ADD CONSTRAINT "sync_meetings_custom_type_id_fkey" FOREIGN KEY ("custom_type_id") REFERENCES "meeting_type_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;
