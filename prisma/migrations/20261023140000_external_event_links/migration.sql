-- COSMOS-202 B2: meetings mirrored into people's Outlook calendars.
-- Meetings get a length (existing rows: 30 minutes, the app's assumption so far).
ALTER TABLE "sync_meetings" ADD COLUMN "duration_minutes" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "external_event_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_calendar_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "change_key" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_event_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_event_links_org_id_provider_user_id_external_event_key" ON "external_event_links"("org_id", "provider", "user_id", "external_event_id");
CREATE UNIQUE INDEX "external_event_links_org_id_provider_user_id_entity_type_en_key" ON "external_event_links"("org_id", "provider", "user_id", "entity_type", "entity_id");
CREATE INDEX "external_event_links_org_id_entity_type_entity_id_idx" ON "external_event_links"("org_id", "entity_type", "entity_id");

ALTER TABLE "external_event_links" ADD CONSTRAINT "external_event_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_event_links" ADD CONSTRAINT "external_event_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
