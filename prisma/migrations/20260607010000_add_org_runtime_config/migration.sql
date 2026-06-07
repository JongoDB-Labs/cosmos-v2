-- GUI runtime-config surface (design §8): the per-org OrgRuntimeConfig store.
--
-- A per-org (1:1) settings row that makes the connector + agent surface GUI/API-tunable
-- instead of code/env. Kept SEPARATE from org_security_settings (auth posture) so the two
-- concerns stay clean. The ABSENCE of a row is the load-bearing default — it means
--   "all registered connectors enabled, breadth on, MCP off" = EXACTLY today's behavior.
-- getRuntimeConfig() normalizes a missing row to that default, so existing orgs are
-- UNAFFECTED until an admin opts in.
--
-- Tri-state connector enablement (Prisma has no nullable scalar list, so a flag + array
-- stand in for the spec's `enabledConnectors String[]?`):
--   allowlist_enabled = false ⇒ ALL registered connectors enabled (default; enabled_connectors
--                               is ignored). allowlist_enabled = true ⇒ only the providers in
--                               enabled_connectors are enabled (a subset; [] then = none).
--
-- GOV GUARDRAILS (applyGovGuardrails + the runtime-config PATCH guard): a GOV org has
-- breadth_enabled=false + mcp_enabled=false and may not list a commercial-only connector in
-- enabled_connectors. tenant_class itself lives on organizations and is platform-owner-only.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy` as the
-- OWNER. Additive + backwards-compatible. IDEMPOTENT (IF NOT EXISTS) so a re-applied deploy
-- is a no-op. This is cosmos_app DML (NOT an audit/immutable table).

CREATE TABLE IF NOT EXISTS "org_runtime_config" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"             UUID NOT NULL,
    "allowlist_enabled"  BOOLEAN NOT NULL DEFAULT false,
    "enabled_connectors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "breadth_enabled"    BOOLEAN NOT NULL DEFAULT true,
    "mcp_enabled"        BOOLEAN NOT NULL DEFAULT false,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_runtime_config_pkey" PRIMARY KEY ("id")
);

-- One config row per org.
CREATE UNIQUE INDEX IF NOT EXISTS "org_runtime_config_org_id_key"
    ON "org_runtime_config" ("org_id");

-- FK to organizations; cascade-delete with the org (it's tenant config, not global state).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'org_runtime_config_org_id_fkey'
    ) THEN
        ALTER TABLE "org_runtime_config"
            ADD CONSTRAINT "org_runtime_config_org_id_fkey"
            FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
