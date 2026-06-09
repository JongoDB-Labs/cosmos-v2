-- Instance-level OAuth sign-in provider config (replaces env-var secrets).
-- Secrets are vault-sealed in secret_enc; this table holds no plaintext creds.
CREATE TABLE "auth_provider_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secret_enc" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_provider_configs_provider_key" ON "auth_provider_configs"("provider");
