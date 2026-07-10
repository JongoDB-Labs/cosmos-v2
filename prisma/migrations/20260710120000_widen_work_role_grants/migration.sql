-- Widen work_roles.grants from int8 (64-bit) to text holding the DECIMAL STRING
-- of the permission bitmask. The Permission space spans bits 0..116 (see
-- src/lib/rbac/permissions.ts), so any grant at bit >= 63 (CRM, NOTE, TIME,
-- THEME, COMPLIANCE, CHAT, AGENT_POLICY_MANAGE, …) overflowed the 64-bit column
-- and surfaced as a 500 when saving a work role. text has no width ceiling; the
-- app reads it back as a JS bigint. Existing numeric values cast cleanly.

-- AlterTable
ALTER TABLE "work_roles" ALTER COLUMN "grants" DROP DEFAULT;
ALTER TABLE "work_roles" ALTER COLUMN "grants" SET DATA TYPE TEXT USING "grants"::text;
ALTER TABLE "work_roles" ALTER COLUMN "grants" SET DEFAULT '0';
