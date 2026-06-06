-- Connector layer slice 1: the vault-sealed credential store.
--
-- Closes a real protect-at-rest gap (SC-28 / 800-171 3.13.16; IA-5; 3.5.10):
-- external connector credentials (today: the live Google OAuth refresh token)
-- were stored PLAINTEXT. This table holds them as AES-256-GCM vault envelopes
-- (v2.<kid>.<iv>.<tag>.<ct>) sealed via src/lib/crypto/vault.ts — the SAME
-- rotatable keyring that already seals OIDC client secrets. The secret bundle is
-- JSON (refreshToken/accessToken/apiKey/...) opened ONLY server-side at call time.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate
-- deploy` as the OWNER (cosmos). Additive + backwards-compatible: fresh installs
-- start sealed; existing plaintext Google tokens drain to sealed on first use via
-- the getGoogleClientForUser self-heal (no migration ordering hazard — this
-- migration does NOT touch users.google_refresh_token; that column drops in a
-- future cleanup once drained). Idempotent (IF NOT EXISTS / IF EXISTS guards) so a
-- re-applied deploy is a no-op.
--
-- NOT an audit table: the 20260606050000 append-only guards do NOT apply. It is a
-- normal app table — cosmos_app needs full DML (the self-heal upsert + reads). It
-- inherits SELECT/INSERT/UPDATE/DELETE from the ALTER DEFAULT PRIVILEGES set in
-- 20260606050000_audit_immutability, but we GRANT explicitly below for clarity.

-- 1. The credential table. One row per (org, provider, user). secret_enc is the
--    vault envelope; meta is NON-secret hints (scopes/account/expiry) only.
CREATE TABLE IF NOT EXISTS "connector_credentials" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "org_id"     UUID         NOT NULL,
    "provider"   TEXT         NOT NULL,
    "user_id"    UUID         NOT NULL,
    "secret_enc" TEXT         NOT NULL,
    "meta"       JSONB        NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_credentials_pkey" PRIMARY KEY ("id")
);

-- 2. The credential identity key: one credential per (org, provider, user).
--    setCredential() upserts on this key. (userId is REQUIRED this slice; org-level
--    null-userId creds + their partial unique index come in the next connector slice.)
CREATE UNIQUE INDEX IF NOT EXISTS "connector_credentials_org_id_provider_user_id_key"
    ON "connector_credentials" ("org_id", "provider", "user_id");

-- 3. Lookup index for provider scans within an org.
CREATE INDEX IF NOT EXISTS "connector_credentials_org_id_provider_idx"
    ON "connector_credentials" ("org_id", "provider");

-- 4. Org FK — credentials are tenant-scoped and vanish with the org.
ALTER TABLE "connector_credentials"
    DROP CONSTRAINT IF EXISTS "connector_credentials_org_id_fkey";
ALTER TABLE "connector_credentials"
    ADD CONSTRAINT "connector_credentials_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Least-privilege DML grant for the app role. cosmos_app already inherits this
--    from the audit-immutability ALTER DEFAULT PRIVILEGES, but we grant explicitly
--    so the table's access posture is self-documenting. This is NOT an audit table,
--    so there is NO UPDATE/DELETE revoke — the self-heal upsert needs full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON "connector_credentials" TO cosmos_app;
