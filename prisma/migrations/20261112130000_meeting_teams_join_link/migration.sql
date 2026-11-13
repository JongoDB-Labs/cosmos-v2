-- Teams meetings for Cosmos meetings pushed to Outlook. Additive: existing
-- meetings get NULL (no Teams meeting). Deleting the host turns it off
-- (SET NULL), never deletes the meeting.
ALTER TABLE "sync_meetings" ADD COLUMN "teams_host_id" UUID;
ALTER TABLE "sync_meetings" ADD COLUMN "teams_join_url" TEXT;
ALTER TABLE "sync_meetings" ADD COLUMN "teams_issue" TEXT;

ALTER TABLE "sync_meetings" ADD CONSTRAINT "sync_meetings_teams_host_id_fkey" FOREIGN KEY ("teams_host_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Finding the meetings someone hosts (they disconnect, leave, or their
-- Outlook is reconciled) without reading every meeting.
CREATE INDEX "sync_meetings_teams_host_id_idx" ON "sync_meetings"("teams_host_id");

-- No join link without a host: however hosting ends (Teams turned off, the
-- host's account deleted by the foreign key above, any write that forgets the
-- link), the link and its issue go with it, so a dead link is never shown.
CREATE OR REPLACE FUNCTION sync_meetings_teams_link_needs_host() RETURNS trigger AS $$
BEGIN
  IF NEW.teams_host_id IS NULL THEN
    NEW.teams_join_url := NULL;
    NEW.teams_issue := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_meetings_teams_link_needs_host
  BEFORE INSERT OR UPDATE OF teams_host_id, teams_join_url, teams_issue ON "sync_meetings"
  FOR EACH ROW EXECUTE FUNCTION sync_meetings_teams_link_needs_host();
