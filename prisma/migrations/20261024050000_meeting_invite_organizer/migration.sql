-- COSMOS-202 B2 invite mode: who sends a meeting's Outlook invitations (null = off).
-- Additive: existing meetings get NULL (invite mode off); deleting the organizer
-- turns it off (SET NULL), never deletes the meeting.
ALTER TABLE "sync_meetings" ADD COLUMN "invite_organizer_id" UUID;

ALTER TABLE "sync_meetings" ADD CONSTRAINT "sync_meetings_invite_organizer_id_fkey" FOREIGN KEY ("invite_organizer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
