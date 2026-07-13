-- Simplify the billing Plan enum from FREE/TEAM/BUSINESS/ENTERPRISE/GOV to
-- BASIC/TEAM/ENTERPRISE. Plan drives FEATURES; data-classification lives on the
-- separate `tenant_class` column (unchanged here). Postgres cannot DROP enum
-- values, so we recreate the type and remap the column with a USING cast, then
-- backfill every org to ENTERPRISE (feature-gating is deferred — all orgs are
-- ENTERPRISE for now).

-- 1. Drop the column default (it references the old type and blocks the cast).
ALTER TABLE "organizations" ALTER COLUMN "plan" DROP DEFAULT;

-- 2. Rename the old type out of the way.
ALTER TYPE "Plan" RENAME TO "Plan_old";

-- 3. Create the new, simplified type.
CREATE TYPE "Plan" AS ENUM ('BASIC', 'TEAM', 'ENTERPRISE');

-- 4. Convert the column, mapping every legacy value to a valid new one
--    (FREE -> BASIC, TEAM -> TEAM, BUSINESS/ENTERPRISE/GOV -> ENTERPRISE).
ALTER TABLE "organizations"
  ALTER COLUMN "plan" TYPE "Plan"
  USING (
    CASE "plan"::text
      WHEN 'FREE' THEN 'BASIC'
      WHEN 'TEAM' THEN 'TEAM'
      WHEN 'BUSINESS' THEN 'ENTERPRISE'
      WHEN 'ENTERPRISE' THEN 'ENTERPRISE'
      WHEN 'GOV' THEN 'ENTERPRISE'
      ELSE 'ENTERPRISE'
    END
  )::"Plan";

-- 5. Reset the default to ENTERPRISE.
ALTER TABLE "organizations" ALTER COLUMN "plan" SET DEFAULT 'ENTERPRISE';

-- 6. Drop the now-unused old type.
DROP TYPE "Plan_old";

-- 7. Backfill: every existing org becomes ENTERPRISE (owner directive — all orgs
--    are ENTERPRISE while feature-gating is deferred).
UPDATE "organizations" SET "plan" = 'ENTERPRISE';
