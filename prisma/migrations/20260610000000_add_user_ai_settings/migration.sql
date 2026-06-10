-- Per-user Claude subscription OAuth (the agent prefers the requesting user's
-- personal token over the org's). Additive: new table only.
CREATE TABLE "user_ai_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'claude-oauth',
    "oauth_access_token" JSONB,
    "oauth_refresh_token" JSONB,
    "oauth_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_ai_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_ai_settings_user_id_key" ON "user_ai_settings"("user_id");

ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
