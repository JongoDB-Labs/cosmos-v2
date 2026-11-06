-- Asking an org for an account, for an admin to approve or deny.
--
-- A row here is NOT a credential and grants nothing. Approval goes through the
-- same Invitation path an admin-initiated invite uses, so there stays exactly
-- one way an account comes into being.
--
-- org_security_settings.account_request_mode defaults to OFF, so no org gains a
-- public request form by upgrading -- it has to be switched on deliberately.

DO $$ BEGIN
  CREATE TYPE "AccountRequestMode" AS ENUM ('OFF', 'ALLOWLIST', 'OPEN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AccountRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "account_requests" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"          UUID NOT NULL,
  "email"           TEXT NOT NULL,
  "note"            TEXT,
  "status"          "AccountRequestStatus" NOT NULL DEFAULT 'PENDING',
  "mode_at_request" "AccountRequestMode" NOT NULL,
  "ip_address"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"      TIMESTAMP(3),
  "decided_by_id"   UUID,
  "invitation_id"   UUID,
  CONSTRAINT "account_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "account_requests_org_id_status_idx"
  ON "account_requests"("org_id", "status");
CREATE INDEX IF NOT EXISTS "account_requests_org_id_email_idx"
  ON "account_requests"("org_id", "email");

-- At most ONE pending request per address per org, case-insensitively: a
-- resubmit must not be able to flood the queue. Partial + expression index, so
-- it cannot be expressed in schema.prisma -- a denial still leaves the address
-- free to ask again, which a plain unique index would prevent.
CREATE UNIQUE INDEX IF NOT EXISTS "account_requests_one_pending_per_email"
  ON "account_requests"("org_id", lower("email"))
  WHERE "status" = 'PENDING';

DO $$ BEGIN
  ALTER TABLE "account_requests"
    ADD CONSTRAINT "account_requests_org_id_fkey" FOREIGN KEY ("org_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The decider is retained for attribution, but deleting a user must not delete
-- the record that a decision was made.
DO $$ BEGIN
  ALTER TABLE "account_requests"
    ADD CONSTRAINT "account_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "org_security_settings"
  ADD COLUMN IF NOT EXISTS "account_request_mode" "AccountRequestMode" NOT NULL DEFAULT 'OFF';
