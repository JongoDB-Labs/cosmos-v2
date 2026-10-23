-- Public API phase 1 (docs/design/2026-10-23-public-api-and-mcp-design.md §3.4–3.5, §4.2).
--
-- 1. api_keys.kind: ORG (an integration key an admin minted) vs PERSONAL (a
--    member's own token from /api/v1/me/tokens). Every existing key is an org
--    key, which is what the default makes it.
-- 2. api_keys.api_version: the Cosmos-API-Version a credential is pinned to
--    when a request names none. Existing keys pin to the first version.
-- 3. api_idempotency_keys: Idempotency-Key replay for POSTs, 24h. The response
--    body is sealed by the application (vault envelope), never stored plain.
--    Inherits cosmos_app's privileges from the default privileges set in
--    20260606050000_audit_immutability (no explicit GRANT needed).
-- CreateEnum
CREATE TYPE "ApiKeyKind" AS ENUM ('ORG', 'PERSONAL');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "api_version" TEXT NOT NULL DEFAULT '2026-11-01',
ADD COLUMN     "kind" "ApiKeyKind" NOT NULL DEFAULT 'ORG';

-- CreateTable
CREATE TABLE "api_idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "credential" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" INTEGER,
    "response_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotency_keys_credential_key_key" ON "api_idempotency_keys"("credential", "key");

-- AddForeignKey
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

