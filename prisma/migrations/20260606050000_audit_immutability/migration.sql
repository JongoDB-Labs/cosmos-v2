-- AU-9 / AU-11 audit-immutability hardening for audit_logs + egress_decisions.
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy`
-- as the OWNER (cosmos). Empirically verified on a real PG16 cluster.

-- 1. FK-decouple: audit survives org/user deletion (org_id CASCADE was the AU-9 bug;
--    user_id SET NULL erased the actor). Keep the columns as recorded data.
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_org_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_user_id_fkey";
CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs" ("user_id");

-- 2. seq precursor (monotonic ordering; future hash-chain needs no rewrite).
ALTER TABLE "audit_logs"      ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "egress_decisions" ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX "audit_logs_seq_key"      ON "audit_logs" ("seq");
CREATE UNIQUE INDEX "egress_decisions_seq_key" ON "egress_decisions" ("seq");

-- 3. Append-only guards (fire for everyone incl. owner; NOT on ALTER TABLE DDL).
CREATE OR REPLACE FUNCTION audit_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only violation: % on % is not permitted (AU-9 immutable audit store)',
    TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END; $$;
CREATE OR REPLACE FUNCTION audit_block_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only violation: TRUNCATE on % is not permitted (AU-9)', TG_TABLE_NAME
    USING ERRCODE = '42501';
END; $$;
CREATE TRIGGER audit_logs_append_only       BEFORE UPDATE OR DELETE ON "audit_logs"       FOR EACH ROW       EXECUTE FUNCTION audit_append_only_guard();
CREATE TRIGGER egress_decisions_append_only BEFORE UPDATE OR DELETE ON "egress_decisions" FOR EACH ROW       EXECUTE FUNCTION audit_append_only_guard();
CREATE TRIGGER audit_logs_no_truncate       BEFORE TRUNCATE ON "audit_logs"               FOR EACH STATEMENT EXECUTE FUNCTION audit_block_truncate();
CREATE TRIGGER egress_decisions_no_truncate BEFORE TRUNCATE ON "egress_decisions"         FOR EACH STATEMENT EXECUTE FUNCTION audit_block_truncate();

-- 4. Role-split: cosmos_app (created at DB init, see compose/init/01-app-role.sh) gets
--    full DML on app tables EXCEPT UPDATE/DELETE/TRUNCATE on the audit tables. Future
--    tables auto-grant via DEFAULT PRIVILEGES. Runs as the owner (cosmos). Idempotent.
GRANT USAGE ON SCHEMA public TO cosmos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cosmos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cosmos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs", "egress_decisions" FROM cosmos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cosmos IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cosmos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cosmos IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cosmos_app;
