-- AgentPolicy (design D9/§8): the per-org AgentPolicy store — the MIDDLE gate of
-- `RBAC ∩ AgentPolicy ∩ Classification` (narrowest wins).
--
-- A per-org (1:1) tenant-admin-managed authorization on what the AI agent may do PER TOOL
-- CALL, enforced in the agent loop BEFORE executeTool (after handle-resolve, before the
-- write-path taint check). This is NOT the egress gate (what the model may SEE) — it governs
-- which TOOLS/DOMAINS the agent may CALL and bounds their args.
--
-- The ABSENCE of a row is the load-bearing default — it means PERMISSIVE: all tools/domains
-- allowed, no arg bounds = EXACTLY today's behavior. getAgentPolicy() normalizes a missing
-- row to that default, so existing orgs are UNAFFECTED until an admin opts in. This is
-- additive + backwards-compatible.
--
-- The 3 axes (D9 thin slice):
--   1. TOOLS  — allowed_tools_set (flag) + allowed_tools (subset) tri-state ALLOWLIST +
--               denied_tools (always-applied denylist, wins).
--   2. DOMAIN — denied_domains: coarse data-domains the agent may not touch (TOOL_DOMAIN map).
--   3. ARGS   — max_result_limit (CLAMP a limit/maxResults arg above it) + allowed_project_ids
--               (tri-state ALLOWLIST: a projectId arg outside the list is refused).
--
-- Tri-state modeled Prisma-native (no nullable scalar list): a <flag>_set boolean + the array.
--   <flag>_set = false ⇒ NULL / no restriction on that axis (default; the array is ignored).
--   <flag>_set = true  ⇒ only the listed values allowed (a subset; [] then = NONE).
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy` as the
-- OWNER. IDEMPOTENT (IF NOT EXISTS) so a re-applied deploy is a no-op. This is cosmos_app DML
-- (NOT an audit/immutable table).

CREATE TABLE IF NOT EXISTS "agent_policy" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"                   UUID NOT NULL,
    "allowed_tools_set"        BOOLEAN NOT NULL DEFAULT false,
    "allowed_tools"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "denied_tools"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "denied_domains"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "max_result_limit"         INTEGER,
    "allowed_project_ids_set"  BOOLEAN NOT NULL DEFAULT false,
    "allowed_project_ids"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_policy_pkey" PRIMARY KEY ("id")
);

-- One policy row per org.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policy_org_id_key"
    ON "agent_policy" ("org_id");

-- FK to organizations; cascade-delete with the org (it's tenant config, not global state).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agent_policy_org_id_fkey'
    ) THEN
        ALTER TABLE "agent_policy"
            ADD CONSTRAINT "agent_policy_org_id_fkey"
            FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
