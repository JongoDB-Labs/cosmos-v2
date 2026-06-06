-- AU-9 in-DB tamper-EVIDENCE hash-chain for audit_logs + egress_decisions.
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy`
-- as the OWNER (cosmos). Empirically verified on a real PG16 cluster (see
-- docs/runbooks/audit-integrity.md for the pasted proof matrix).
--
-- Each row gets a cryptographic hash (row_hash) that binds the PREVIOUS row's hash
-- (prev_hash) plus this row's content. Any post-hoc insert/delete/reorder/modify of a
-- historical row breaks the chain, detectable in-DB by verify_audit_chain(). This is the
-- in-DB half of the AU-9 tamper-evidence story; scripts/audit-worm-export.mjs is the
-- offsite WORM anchor (defense in depth — see the runbook).
--
-- HARD CONSTRAINT: the 20260606050000_audit_immutability append-only guards block ALL
-- UPDATE/DELETE/TRUNCATE on these tables (for everyone, incl. the owner). So the hash
-- CANNOT be backfilled by a later UPDATE — it MUST be set on NEW inside a BEFORE INSERT
-- row trigger, before the row is written. This migration does exactly that.
--
-- TWO PRIOR BUGS DESIGNED OUT (and empirically re-proven avoided in Task 2):
--   1. jsonb_each ERRORS on non-object metadata (metadata can be any JSON value: array,
--      string, number, json null, not just an object). We NEVER call jsonb_each — we hash
--      metadata as frame(NEW.metadata::text), i.e. the stored jsonb's deterministic text
--      rendering. Non-object metadata is just text to the framer.
--   2. A chr(0) NUL byte used as a text separator is ILLEGAL in PG `text`. We use a
--      length-framed BYTEA concatenation (no text separators, all-bytes-safe).

-- 1. pgcrypto for digest(bytea,'sha256'). Idempotent. (schema.prisma already lists it in
--    datasource extensions; this guarantees it on a fresh deploy regardless of order.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Chain columns. NULLABLE + NO DEFAULT so the Prisma client never writes them — the
--    BEFORE INSERT trigger fills them, exactly like the `seq` IDENTITY column.
--    prev_hash is NULL only for the genesis row (the first row ever inserted).
ALTER TABLE "audit_logs"      ADD COLUMN IF NOT EXISTS "row_hash"  BYTEA;
ALTER TABLE "audit_logs"      ADD COLUMN IF NOT EXISTS "prev_hash" BYTEA;
ALTER TABLE "egress_decisions" ADD COLUMN IF NOT EXISTS "row_hash"  BYTEA;
ALTER TABLE "egress_decisions" ADD COLUMN IF NOT EXISTS "prev_hash" BYTEA;

-- 3. Length-framed BYTEA helper. frame(t) = int4send(byte-length of UTF8(t)) || UTF8(t).
--    All-bytes-safe: a 4-byte big-endian length prefix makes the concatenation injective
--    (no value can be confused for a different field boundary) WITHOUT any in-band
--    separator — so no NUL, no jsonb_each, no text-separator illegality. NULL collapses to
--    coalesce(...,'') => a 0-length frame; this is consistent between seal (the trigger)
--    and verify (verify_audit_chain), which is all tamper-evidence requires. IMMUTABLE so
--    it can be inlined and is replay-stable. Defined in pg_catalog-safe pure SQL.
CREATE OR REPLACE FUNCTION frame(t text) RETURNS bytea
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT int4send(length(convert_to(coalesce(t, ''), 'UTF8')))
         || convert_to(coalesce(t, ''), 'UTF8');
$$;

-- 4. Per-table BEFORE INSERT hash-chain trigger functions.
--    - pg_advisory_xact_lock(<stable per-table bigint>) serializes chain extension so two
--      concurrent fire-and-forget inserts cannot both bind the same chain head (a FORK).
--      Released automatically at txn end. Keys are arbitrary but STABLE + distinct per table.
--    - prev := current chain head (row_hash of the max-seq row); NULL => genesis.
--    - row_hash := sha256( coalesce(prev,'') || frame(every persisted column) ).
--    NOTE on NEW.seq: GENERATED ALWAYS AS IDENTITY is assigned by the executor AFTER
--    BEFORE-INSERT triggers run, so NEW.seq is NULL here (empirically confirmed, Task 2a).
--    We therefore do NOT hash NEW.seq (it would be a constant null frame and add nothing).
--    Row ORDERING is bound into the chain by prev_hash alone: each row's hash includes the
--    prior row's row_hash, so any reorder/insert/delete changes a downstream prev linkage
--    and is detected. seq is used only to READ the chain in order (it is itself immutable
--    via the append-only guard + unique index).
--    No SECURITY DEFINER: the trigger only SELECTs the same table the caller inserts into
--    (cosmos_app has SELECT) and sets NEW — no elevated privilege required.

-- audit_logs: columns id, org_id, user_id, action, entity, entity_id, metadata,
--             ip_address, created_at.
CREATE OR REPLACE FUNCTION audit_logs_hash_chain() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(491000001);
  SELECT row_hash INTO prev FROM "audit_logs" ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(prev, ''::bytea)
      || frame(NEW.id::text)
      || frame(NEW.org_id::text)
      || frame(NEW.user_id::text)
      || frame(NEW.action)
      || frame(NEW.entity)
      || frame(NEW.entity_id)
      || frame(NEW.metadata::text)
      || frame(NEW.ip_address)
      || frame(NEW.created_at::text),
    'sha256');
  RETURN NEW;
END; $$;

-- egress_decisions: columns id, conversation_id, turn, value_kind, tool_name, exposed,
--                   withheld_count, content_hash, decided_by, tenant_class, ceiling,
--                   created_at.
CREATE OR REPLACE FUNCTION egress_decisions_hash_chain() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(491000002);
  SELECT row_hash INTO prev FROM "egress_decisions" ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(prev, ''::bytea)
      || frame(NEW.id::text)
      || frame(NEW.conversation_id)
      || frame(NEW.turn::text)
      || frame(NEW.value_kind)
      || frame(NEW.tool_name)
      || frame(NEW.exposed::text)
      || frame(NEW.withheld_count::text)
      || frame(NEW.content_hash)
      || frame(NEW.decided_by)
      || frame(NEW.tenant_class)
      || frame(NEW.ceiling)
      || frame(NEW.created_at::text),
    'sha256');
  RETURN NEW;
END; $$;

-- Triggers. DROP-then-CREATE for idempotency (CREATE TRIGGER has no OR REPLACE in PG16).
DROP TRIGGER IF EXISTS audit_logs_hash_chain       ON "audit_logs";
DROP TRIGGER IF EXISTS egress_decisions_hash_chain ON "egress_decisions";
CREATE TRIGGER audit_logs_hash_chain       BEFORE INSERT ON "audit_logs"       FOR EACH ROW EXECUTE FUNCTION audit_logs_hash_chain();
CREATE TRIGGER egress_decisions_hash_chain BEFORE INSERT ON "egress_decisions" FOR EACH ROW EXECUTE FUNCTION egress_decisions_hash_chain();

-- 5. Verification function. Walks rows in seq order, recomputing each row_hash from the
--    PRIOR row's STORED row_hash + this row's framed columns (the SAME canonicalization the
--    trigger used). Returns the first broken row:
--      - 'prev_hash != prior row_hash'  => an insert/delete/reorder broke the linkage, OR
--      - 'row_hash mismatch (content tampered)' => a column value was mutated in place.
--    Empty result set => the chain is intact end to end.
--    regclass param so one function serves both tables; recomputation is branched on the
--    table name so each table's exact column list is hashed identically to its trigger.
--    Marked STABLE (reads tables, no writes). cosmos_app needs only SELECT to run it.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_table regclass)
  RETURNS TABLE(broken_seq bigint, reason text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  prev bytea := NULL;       -- the STORED row_hash of the prior row (NULL before genesis)
  recomputed bytea;
  tname text := p_table::text;
BEGIN
  IF tname NOT IN ('audit_logs', 'egress_decisions') THEN
    RAISE EXCEPTION 'verify_audit_chain: unsupported table %', tname
      USING ERRCODE = '22023';
  END IF;

  IF tname = 'audit_logs' THEN
    FOR r IN SELECT * FROM "audit_logs" ORDER BY seq ASC LOOP
      recomputed := digest(
        coalesce(prev, ''::bytea)
          || frame(r.id::text)
          || frame(r.org_id::text)
          || frame(r.user_id::text)
          || frame(r.action)
          || frame(r.entity)
          || frame(r.entity_id)
          || frame(r.metadata::text)
          || frame(r.ip_address)
          || frame(r.created_at::text),
        'sha256');
      IF r.prev_hash IS DISTINCT FROM prev THEN
        broken_seq := r.seq;
        reason := 'prev_hash != prior row_hash (insert/delete/reorder break)';
        RETURN NEXT; RETURN;
      END IF;
      IF r.row_hash IS DISTINCT FROM recomputed THEN
        broken_seq := r.seq;
        reason := 'row_hash mismatch (content tampered)';
        RETURN NEXT; RETURN;
      END IF;
      prev := r.row_hash;
    END LOOP;
  ELSE
    FOR r IN SELECT * FROM "egress_decisions" ORDER BY seq ASC LOOP
      recomputed := digest(
        coalesce(prev, ''::bytea)
          || frame(r.id::text)
          || frame(r.conversation_id)
          || frame(r.turn::text)
          || frame(r.value_kind)
          || frame(r.tool_name)
          || frame(r.exposed::text)
          || frame(r.withheld_count::text)
          || frame(r.content_hash)
          || frame(r.decided_by)
          || frame(r.tenant_class)
          || frame(r.ceiling)
          || frame(r.created_at::text),
        'sha256');
      IF r.prev_hash IS DISTINCT FROM prev THEN
        broken_seq := r.seq;
        reason := 'prev_hash != prior row_hash (insert/delete/reorder break)';
        RETURN NEXT; RETURN;
      END IF;
      IF r.row_hash IS DISTINCT FROM recomputed THEN
        broken_seq := r.seq;
        reason := 'row_hash mismatch (content tampered)';
        RETURN NEXT; RETURN;
      END IF;
      prev := r.row_hash;
    END LOOP;
  END IF;

  RETURN;  -- no rows => chain intact
END; $$;

-- 6. cosmos_app may EXECUTE the verify function (SELECT-only on the tables; no extra grant
--    needed for the trigger functions — they fire implicitly on INSERT as the inserting
--    role, which already has SELECT). EXECUTE on functions is granted to PUBLIC by default;
--    this is explicit + idempotent for auditability.
GRANT EXECUTE ON FUNCTION verify_audit_chain(regclass) TO cosmos_app;
GRANT EXECUTE ON FUNCTION frame(text) TO cosmos_app;
