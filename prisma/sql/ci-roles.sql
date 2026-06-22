-- CI-only bootstrap: create the DB roles the migrations GRANT against.
--
-- The compose stack creates these at DB init (compose/init/01-app-role.sh), but a
-- GitHub Actions `services:` Postgres does not run init scripts. Migration
-- 20260606050000_audit_immutability does an UNGUARDED `GRANT ... TO cosmos_app`
-- and `ALTER DEFAULT PRIVILEGES FOR ROLE cosmos ...`, so both roles must exist
-- before `prisma migrate deploy`. Idempotent; safe to re-run. Apply with:
--   npx prisma db execute --schema prisma/schema.prisma --file prisma/sql/ci-roles.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cosmos') THEN
    CREATE ROLE cosmos;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cosmos_app') THEN
    CREATE ROLE cosmos_app LOGIN PASSWORD 'cosmos_app';
  END IF;
END $$;
