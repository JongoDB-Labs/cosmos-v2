-- Webhooks: who created each one, and which project each delivery is about.
--
-- A webhook sends an event only if its creator can read the event's project
-- when it is sent, and stops once its creator leaves the org; a delivery's
-- payload is shown only to people who can read its project. Existing webhooks
-- have no recorded creator and so send nothing until recreated.
--
-- One DO block, so it applies whole or not at all (prisma migrate deploy sends
-- each top-level statement on its own).
DO $$
BEGIN
  ALTER TABLE "webhooks" ADD COLUMN "created_by_id" UUID;
  ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  ALTER TABLE "webhook_deliveries" ADD COLUMN "project_id" UUID;
  -- Deliveries already queued carry their project in the payload.
  UPDATE "webhook_deliveries"
     SET "project_id" = ("payload"->>'projectId')::uuid
   WHERE "payload"->>'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
END $$;
