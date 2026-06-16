-- Per-tenant feature entitlements (Pontis foundation §3.2): the per-org OrgEntitlements store.
--
-- A per-org (1:1) row gating which product MODULES and industry SECTORS a tenant sees.
-- The ABSENCE of a row is the load-bearing default — it means "ALL modules + ALL sectors
-- enabled" = EXACTLY today's behavior. getEntitlements() normalizes a missing row to that
-- default, so existing orgs are UNAFFECTED until a product/admin restricts something.
--
-- Tri-state (Prisma has no nullable scalar list, so a flag + array stand in for `String[]?`):
--   module_allowlist_enabled = false ⇒ ALL modules enabled (default; enabled_modules ignored).
--   module_allowlist_enabled = true  ⇒ only the keys in enabled_modules are enabled ([] = none).
-- Same shape for sectors. FIXED modules (overview, settings) are always on, enforced in code.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy` as the
-- OWNER. Additive + backwards-compatible. IDEMPOTENT (IF NOT EXISTS) so a re-applied deploy
-- is a no-op. This is cosmos_app DML (NOT an audit/immutable table).

CREATE TABLE IF NOT EXISTS "org_entitlements" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"                   UUID NOT NULL,
    "module_allowlist_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_modules"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sector_allowlist_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_sectors"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_entitlements_pkey" PRIMARY KEY ("id")
);

-- One entitlements row per org.
CREATE UNIQUE INDEX IF NOT EXISTS "org_entitlements_org_id_key"
    ON "org_entitlements" ("org_id");

-- FK to organizations; cascade-delete with the org (it's tenant config, not global state).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'org_entitlements_org_id_fkey'
    ) THEN
        ALTER TABLE "org_entitlements"
            ADD CONSTRAINT "org_entitlements_org_id_fkey"
            FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
