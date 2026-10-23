-- COSMOS-202 B2 invite mode: who sends a meeting's Outlook invitations (null = off).
-- PLACEHOLDER TIMESTAMP: re-timestamped after the migrations ahead of it in the
-- hotspot-prisma queue (workflow P1, backlog Phase 2) have landed.
ALTER TABLE "sync_meetings" ADD COLUMN "invite_organizer_id" UUID;

ALTER TABLE "sync_meetings" ADD CONSTRAINT "sync_meetings_invite_organizer_id_fkey" FOREIGN KEY ("invite_organizer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
