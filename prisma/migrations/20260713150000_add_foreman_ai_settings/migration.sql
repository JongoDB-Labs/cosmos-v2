CREATE TABLE "foreman_ai_settings" (
  "org_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'claude-oauth',
  "oauth_access_token" JSONB,
  "oauth_refresh_token" JSONB,
  "oauth_expires_at" TIMESTAMP(3),
  "updated_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "foreman_ai_settings_pkey" PRIMARY KEY ("org_id")
);
