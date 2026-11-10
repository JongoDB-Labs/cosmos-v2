-- Program calendar: org-defined event categories, and the events themselves.
--
-- Defensive throughout (IF NOT EXISTS / duplicate_object), matching the rest of
-- this directory: these migrations are replayed against instances that may
-- already carry part of the shape.

DO $$ BEGIN
  CREATE TYPE "EventRecurrence" AS ENUM ('NONE','DAILY','WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','ANNUALLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "event_categories" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"      UUID         NOT NULL,
  "name"        TEXT         NOT NULL,
  "tint_rgb"    TEXT         NOT NULL,
  "tint_alpha"  DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  "text_color"  TEXT         NOT NULL,
  "sort_order"  INTEGER      NOT NULL DEFAULT 0,
  "archived_at" TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "program_events" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"             UUID         NOT NULL,
  "project_id"         UUID,
  "category_id"        UUID         NOT NULL,
  "title"              TEXT         NOT NULL,
  "starts_at"          TIMESTAMP(3) NOT NULL,
  "ends_at"            TIMESTAMP(3) NOT NULL,
  "all_day"            BOOLEAN      NOT NULL DEFAULT false,
  "time_zone"          TEXT         NOT NULL DEFAULT 'America/New_York',
  "location"           TEXT,
  "owner_team_id"      UUID,
  "owner_member_id"    UUID,
  "attendees"          TEXT         NOT NULL DEFAULT '',
  "recurrence"         "EventRecurrence" NOT NULL DEFAULT 'NONE',
  "deliverable_id"     UUID,
  "customer_attending" BOOLEAN      NOT NULL DEFAULT false,
  "description"        TEXT         NOT NULL DEFAULT '',
  "show_on_dashboard"  BOOLEAN      NOT NULL DEFAULT false,
  "external_id"        TEXT,
  "created_by_id"      UUID         NOT NULL,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "program_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_categories_org_id_name_key" ON "event_categories"("org_id","name");
CREATE INDEX        IF NOT EXISTS "event_categories_org_id_sort_order_idx" ON "event_categories"("org_id","sort_order");

-- NULL external_id repeats freely in Postgres, which is exactly what we want:
-- every event created in the app has none, and only imported/synced events are
-- held to one row per source id.
CREATE UNIQUE INDEX IF NOT EXISTS "program_events_org_id_external_id_key" ON "program_events"("org_id","external_id");
CREATE INDEX        IF NOT EXISTS "program_events_org_id_starts_at_idx" ON "program_events"("org_id","starts_at");
CREATE INDEX        IF NOT EXISTS "program_events_org_id_project_id_starts_at_idx" ON "program_events"("org_id","project_id","starts_at");
CREATE INDEX        IF NOT EXISTS "program_events_category_id_idx" ON "program_events"("category_id");

DO $$ BEGIN
  ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_owner_team_id_fkey"
    FOREIGN KEY ("owner_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_owner_member_id_fkey"
    FOREIGN KEY ("owner_member_id") REFERENCES "org_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_deliverable_id_fkey"
    FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "program_events" ADD CONSTRAINT "program_events_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
