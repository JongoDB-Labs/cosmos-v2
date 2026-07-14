-- Per-org transactional-email (Resend) delivery config, set by an org OWNER from the
-- org settings UI instead of a server env var. Additive: new table only. Surrogate
-- `id` PK + UNIQUE(org_id) mirrors org_ai_settings/foreman_ai_settings (one row per org);
-- the FK cascades the row away with its owning Organization. The provider API key lives
-- SEALED in the JSONB `api_key` column ({ sealed: <ciphertext> }) — never plaintext.
CREATE TABLE "org_email_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "api_key" JSONB,
    "from_address" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_email_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_email_settings_org_id_key" ON "org_email_settings"("org_id");

ALTER TABLE "org_email_settings" ADD CONSTRAINT "org_email_settings_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
