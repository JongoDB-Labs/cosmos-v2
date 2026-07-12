-- Permission bitfield outgrew BIGINT (bits >= 63 overflow); masks move to
-- decimal-string TEXT. USING ::text is a no-op-safe cast if a column already
-- drifted to text (observed on one environment).
ALTER TABLE "org_members" ALTER COLUMN "permissions" DROP DEFAULT;
ALTER TABLE "org_members" ALTER COLUMN "permissions" TYPE TEXT USING "permissions"::text;
ALTER TABLE "org_members" ALTER COLUMN "permissions" SET DEFAULT '0';
ALTER TABLE "work_roles" ALTER COLUMN "grants" DROP DEFAULT;
ALTER TABLE "work_roles" ALTER COLUMN "grants" TYPE TEXT USING "grants"::text;
ALTER TABLE "work_roles" ALTER COLUMN "grants" SET DEFAULT '0';
