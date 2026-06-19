-- Phase 2 (runtime-skins/brand pivot): per-org white-label brand columns.
--
-- Five nullable columns on organizations. NULL is the load-bearing default —
-- it means "inherit the deployment/product brand from getBrand()", i.e. EXACTLY
-- today's behavior. resolveBrand(org) overlays only non-null columns, so every
-- existing org is UNAFFECTED until an admin sets a field in Settings → Themes.
--
-- default_skin_id is validated against SKIN_PRESETS at the API boundary
-- (isValidSkinId), NOT by a DB constraint, so adding a new skin preset never
-- requires a migration.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via
-- `prisma migrate deploy` as the OWNER. Additive + backwards-compatible.
-- IDEMPOTENT (IF NOT EXISTS) so a re-applied deploy is a no-op.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "default_skin_id" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "brand_name" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "agent_name" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "tagline" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "wake_word" TEXT;
