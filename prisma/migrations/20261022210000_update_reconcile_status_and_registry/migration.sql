-- /admin/updates: what the host-side installer last did, and registry settings
-- an admin can see and fix from the page.
--
-- ADDITIVE ONLY. New nullable columns and a new table; no existing column,
-- default or constraint changes, so an old app image keeps working against the
-- migrated schema during a rollout.

-- Registry overrides. NULL = "use the environment", which is what every
-- existing row means today, so the columns need no backfill. The password
-- column holds a vault envelope (src/lib/crypto/field-seal.ts), never plaintext.
ALTER TABLE "update_settings" ADD COLUMN IF NOT EXISTS "image_repo" TEXT;
ALTER TABLE "update_settings" ADD COLUMN IF NOT EXISTS "tag_suffix" TEXT;
ALTER TABLE "update_settings" ADD COLUMN IF NOT EXISTS "registry_username" TEXT;
ALTER TABLE "update_settings" ADD COLUMN IF NOT EXISTS "registry_password_enc" TEXT;

-- The installer's last report. A singleton overwritten on every pass; a stale
-- checked_at is how the page notices the installer has stopped.
CREATE TABLE IF NOT EXISTS "update_reconcile_status" (
  "id"              TEXT PRIMARY KEY,
  "scope"           TEXT NOT NULL DEFAULT 'instance',
  "outcome"         TEXT NOT NULL,
  "message"         TEXT NOT NULL,
  "latest_released" TEXT,
  "running_version" TEXT,
  "source"          TEXT,
  "checked_at"      TIMESTAMP(3) NOT NULL,
  "failing_since"   TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per deployment, so an upsert race cannot leave two reports and the
-- page pick one arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS "update_reconcile_status_scope_key" ON "update_reconcile_status" ("scope");
