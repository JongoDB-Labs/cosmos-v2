-- Instance-wide "install updates by yourself?" switch, for /admin/updates.
--
-- Defaults to TRUE: that is what every deployment already does, so creating the
-- row changes no behaviour. The default deliberately favours updating, because
-- the failure this control exists to make visible — an instance quietly stuck on
-- an old release while reporting success — is worse than an unattended install
-- an operator can see and roll back.
CREATE TABLE IF NOT EXISTS "update_settings" (
  "id"            TEXT PRIMARY KEY,
  "scope"         TEXT NOT NULL DEFAULT 'instance',
  "auto_update"   BOOLEAN NOT NULL DEFAULT true,
  "updated_by_id" UUID,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per deployment. Without this an upsert race could leave two rows and
-- the reader would pick one arbitrarily — a setting that silently disagrees with
-- what the operator set is worse than no setting.
CREATE UNIQUE INDEX IF NOT EXISTS "update_settings_scope_key" ON "update_settings" ("scope");
