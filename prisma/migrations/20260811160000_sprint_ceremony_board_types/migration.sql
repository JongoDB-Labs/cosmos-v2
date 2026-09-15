-- The two ceremony board types.
--
-- Separate from the migration that created the ceremony tables on purpose:
-- Postgres will not let a new enum value be USED in the same transaction that
-- adds it, and Prisma runs each migration in one. Splitting them keeps both
-- applicable in any order a deploy chooses.
--
-- IF NOT EXISTS so re-running against a database that already has them is a
-- no-op rather than an error.

ALTER TYPE "public"."BoardType" ADD VALUE IF NOT EXISTS 'SPRINT_PLANNING';
ALTER TYPE "public"."BoardType" ADD VALUE IF NOT EXISTS 'SPRINT_REVIEW';
