-- CreateEnum
CREATE TYPE "TenantClass" AS ENUM ('GOV', 'COMMERCIAL');

-- AlterTable: add NOT NULL with a fail-closed GOV default
ALTER TABLE "organizations" ADD COLUMN "tenant_class" "TenantClass" NOT NULL DEFAULT 'GOV';

-- Backfill existing orgs from the billing plan: GOV plan -> GOV, everything else -> COMMERCIAL.
-- (New orgs keep the fail-closed GOV default until the app/GUI sets them explicitly.)
UPDATE "organizations" SET "tenant_class" = 'COMMERCIAL' WHERE "plan" <> 'GOV';
