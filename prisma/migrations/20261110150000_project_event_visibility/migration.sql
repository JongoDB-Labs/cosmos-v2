-- Who may see a project's program-calendar events.
--
-- Defaults to PROJECT (members only). The event store is org-wide, so an
-- org-visible default would have shown every project's calendar to every
-- member the moment the feature was enabled.

DO $$ BEGIN
  CREATE TYPE "ProjectEventVisibility" AS ENUM ('PROJECT','ORG');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "event_visibility" "ProjectEventVisibility" NOT NULL DEFAULT 'PROJECT';
