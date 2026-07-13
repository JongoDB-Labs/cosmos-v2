-- Foreman's OWN per-org Claude subscription OAuth — a dedicated autonomous-delivery
-- connection, distinct from org_ai_settings. Additive: new table only. Surrogate
-- `id` PK + UNIQUE(org_id) mirrors org_ai_settings/user_ai_settings (one row per org);
-- the FK cascades the row away with its owning Organization.
CREATE TABLE "foreman_ai_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'claude-oauth',
    "oauth_access_token" JSONB,
    "oauth_refresh_token" JSONB,
    "oauth_expires_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_ai_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "foreman_ai_settings_org_id_key" ON "foreman_ai_settings"("org_id");

ALTER TABLE "foreman_ai_settings" ADD CONSTRAINT "foreman_ai_settings_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
