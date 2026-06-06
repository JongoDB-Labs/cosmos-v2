-- Seal McpServer.env / McpServer.headers at rest (SC-28 / 800-171 3.13.16; IA-5).
--
-- An MCP server's `env` (stdio process env — typically API tokens) and `headers`
-- (http/sse auth headers — typically bearer tokens) were stored as PLAINTEXT JSON.
-- They are SECRET. They now live as AES-256-GCM vault envelopes
-- (v2.<kid>.<iv>.<tag>.<ct>) of JSON.stringify(map) in new TEXT columns
-- env_enc / headers_enc, sealed via src/lib/crypto/field-seal.ts on the SAME
-- rotatable keyring (scripts/dsop/rotate-vault-key.mjs re-wraps them).
--
-- MCP EXECUTION IS DORMANT in Phase 0 (the host-CLI --mcp-config wiring was
-- removed; nothing reads these at runtime), so there is NO existing data to
-- migrate: we DROP the plaintext Json columns outright rather than carry a
-- deprecated copy. A fresh seal-on-write path (the create/update routes) + the
-- getMcpEnv()/getMcpHeaders() accessors cover it for when MCP wakes in Phase 4.
--
-- Hand-written; applied via `prisma migrate deploy` as the OWNER (cosmos).
-- Idempotent (IF EXISTS / IF NOT EXISTS guards) so a re-applied deploy is a no-op.
-- cosmos_app inherits SELECT/INSERT/UPDATE/DELETE on mcp_servers from the
-- ALTER DEFAULT PRIVILEGES set in 20260606050000_audit_immutability (no extra grant).

-- Add the sealed columns (nullable: a server with no env/headers stores NULL).
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "env_enc"     TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "headers_enc" TEXT;

-- Drop the plaintext Json columns (dormant — no data to preserve).
ALTER TABLE "mcp_servers" DROP COLUMN IF EXISTS "env";
ALTER TABLE "mcp_servers" DROP COLUMN IF EXISTS "headers";
