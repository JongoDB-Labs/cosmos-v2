#!/bin/sh
# Runs ONCE at first DB init (postgres entrypoint, as the superuser), BEFORE any
# `prisma migrate deploy`. Creates the least-privilege app login role `cosmos_app`.
# Table GRANT/REVOKE for this role live in the 20260606050000_audit_immutability
# migration (which runs after, as the owner). On a PRE-EXISTING volume this script
# does NOT re-run — create the role + grants manually then (see .env.example /
# the migration's idempotent GRANTs).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cosmos_app') THEN
    CREATE ROLE cosmos_app LOGIN PASSWORD '${COSMOS_APP_PASSWORD:-cosmos_app}';
  END IF;
END \$\$;
SQL
