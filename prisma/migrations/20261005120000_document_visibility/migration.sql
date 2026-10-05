-- Per-file visibility: a default that changes nothing, and a restricted mode.
--
-- Created idempotently throughout. INHERIT is the default so every file that
-- already exists keeps exactly the visibility it has today — this migration must
-- not quietly hide anything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentVisibility') THEN
    CREATE TYPE "DocumentVisibility" AS ENUM ('INHERIT', 'RESTRICTED');
  END IF;
END $$;

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "visibility" "DocumentVisibility" NOT NULL DEFAULT 'INHERIT';

CREATE TABLE IF NOT EXISTS "document_shares" (
  "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id"        uuid NOT NULL,
  "document_id"   uuid NOT NULL,
  "user_id"       uuid NOT NULL,
  "granted_by_id" uuid NOT NULL,
  "created_at"    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_shares_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_shares_org_id_fkey') THEN
    ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_shares_document_id_fkey') THEN
    ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One grant per person per file, so re-sharing is idempotent rather than a second
-- row that would have to be de-duplicated at read time.
CREATE UNIQUE INDEX IF NOT EXISTS "document_shares_document_id_user_id_key"
  ON "document_shares" ("document_id", "user_id");

-- Drives "which restricted files may I see" in the library query.
CREATE INDEX IF NOT EXISTS "document_shares_org_id_user_id_idx"
  ON "document_shares" ("org_id", "user_id");
