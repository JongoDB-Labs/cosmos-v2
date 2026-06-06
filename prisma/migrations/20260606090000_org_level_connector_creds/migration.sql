-- Connector layer slice 2: org-level (userId-null) sealed credentials.
--
-- The slice-1 connector_credentials table modeled creds as one row per
-- (org, provider, user) with userId REQUIRED — fine for per-user Google grants.
-- This slice adds ORG-LEVEL credentials (userId NULL): an org-SHARED secret such
-- as a GitHub fine-grained PAT or a Nango/DocuSign service credential, owned by
-- the org and used by any of the org's agents (strictly org-scoped — never read
-- cross-org). Same protect-at-rest posture (SC-28 / 800-171 3.13.16; IA-5;
-- 3.5.10): secret_enc stays a vault envelope, sealed before it touches the DB.
--
-- WHY PARTIAL UNIQUE INDEXES (not the slice-1 plain unique):
--   A plain UNIQUE(org_id, provider, user_id) can NOT enforce "at most one
--   org-level row per (org, provider)" because Postgres treats NULL user_ids as
--   DISTINCT — two NULL-userId rows for the same (org, provider) would both be
--   allowed, breaking the org-level identity. So we replace the single index with
--   TWO partial unique indexes:
--     1. per-user : UNIQUE(org_id, provider, user_id) WHERE user_id IS NOT NULL
--                   — preserves slice-1 semantics for existing per-user rows.
--     2. org-level: UNIQUE(org_id, provider)          WHERE user_id IS NULL
--                   — exactly one shared credential per (org, provider).
--   These are disjoint (the WHERE clauses partition on user_id NULLability), so a
--   per-user row and an org-level row for the SAME (org, provider) coexist without
--   collision — which is the whole point.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate
-- deploy` as the OWNER (cosmos). Additive + backwards-compatible: existing
-- per-user rows keep working under index #1; making user_id NULLABLE never
-- invalidates an existing NOT-NULL value. Idempotent (IF EXISTS / IF NOT EXISTS)
-- so a re-applied deploy is a no-op.

-- 1. user_id becomes NULLABLE (org-level rows store NULL here).
ALTER TABLE "connector_credentials"
    ALTER COLUMN "user_id" DROP NOT NULL;

-- 2. Drop the slice-1 plain unique index (it can't enforce org-level uniqueness).
DROP INDEX IF EXISTS "connector_credentials_org_id_provider_user_id_key";

-- 3. Per-user partial unique index — one credential per (org, provider, user).
--    setCredential() upserts on this key for non-null userIds.
CREATE UNIQUE INDEX IF NOT EXISTS "connector_credentials_org_provider_user_uq"
    ON "connector_credentials" ("org_id", "provider", "user_id")
    WHERE "user_id" IS NOT NULL;

-- 4. Org-level partial unique index — exactly one shared credential per
--    (org, provider). setOrgCredential() writes the single NULL-userId row.
CREATE UNIQUE INDEX IF NOT EXISTS "connector_credentials_org_provider_orglevel_uq"
    ON "connector_credentials" ("org_id", "provider")
    WHERE "user_id" IS NULL;
