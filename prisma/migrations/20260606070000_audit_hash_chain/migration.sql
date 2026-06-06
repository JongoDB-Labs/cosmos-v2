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

-- Index prev_hash: the BEFORE INSERT trigger finds the chain TAIL via a NOT EXISTS anti-join
-- on prev_hash (see below), and verify_audit_chain follows prev_hash links — both want this.
CREATE INDEX IF NOT EXISTS "audit_logs_prev_hash_idx"       ON "audit_logs" ("prev_hash");
CREATE INDEX IF NOT EXISTS "egress_decisions_prev_hash_idx" ON "egress_decisions" ("prev_hash");
-- Index row_hash: verify_audit_chain resolves each row's prev_hash -> the prior row by row_hash.
CREATE INDEX IF NOT EXISTS "audit_logs_row_hash_idx"        ON "audit_logs" ("row_hash");
CREATE INDEX IF NOT EXISTS "egress_decisions_row_hash_idx"  ON "egress_decisions" ("row_hash");

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
--    - prev := the current chain TAIL — the row whose row_hash is not yet referenced by any
--      row's prev_hash. Under the serializing lock this tail is UNIQUE; NULL => genesis.
--    - row_hash := sha256( coalesce(prev,'') || frame(every persisted column) ).
--
--    *** WHY THE TAIL, NOT `ORDER BY seq DESC` (empirically-driven fix — Task 2f) ***
--    A GENERATED ALWAYS AS IDENTITY `seq` is allocated when the tuple is FORMED, which is
--    BEFORE the BEFORE-INSERT trigger fires (confirmed Task 2a: NEW.seq is already set) AND
--    OUTSIDE the advisory lock. So seq-allocation order does NOT match lock-acquisition
--    (= chain-extension) order under concurrency: a txn that grabbed a smaller seq can
--    extend the chain AFTER one with a larger seq. Selecting the head by `ORDER BY seq DESC`
--    therefore let two concurrent inserts both pick the same max-seq row => a FORK (an
--    empirically-observed 8-fork failure on 200 parallel inserts). Selecting the actual
--    TAIL (no row references it as prev_hash) is correct regardless of seq-vs-lock ordering:
--    the lock guarantees exactly one tail at a time, so the chain stays strictly linear.
--    The chain is thus a LINKED LIST; verify_audit_chain walks it by following prev_hash
--    links from genesis, NOT by seq (seq order may legitimately differ from chain order).
--
--    NOTE on NEW.seq: it is included as frame(NEW.seq::text) to cryptographically bind each
--    row to its monotonic id (immutable via the append-only guard + unique index) — but it
--    is NOT used to ORDER the chain (see above). The verifier reads each row's own stored
--    seq, so this is replay-stable.
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
  -- The tail: the one row whose row_hash nobody else has chained onto. NULL on an empty
  -- table (genesis). The advisory lock makes this unique within the critical section.
  SELECT a.row_hash INTO prev FROM "audit_logs" a
    WHERE NOT EXISTS (SELECT 1 FROM "audit_logs" b WHERE b.prev_hash = a.row_hash);
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(prev, ''::bytea)
      || frame(NEW.seq::text)
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
  -- The tail (see audit_logs_hash_chain for the seq-vs-lock-order rationale).
  SELECT a.row_hash INTO prev FROM "egress_decisions" a
    WHERE NOT EXISTS (SELECT 1 FROM "egress_decisions" b WHERE b.prev_hash = a.row_hash);
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(prev, ''::bytea)
      || frame(NEW.seq::text)
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

-- 5. Verification function. The chain is a LINKED LIST (see the trigger note on why seq
--    order need not equal chain order under concurrency). So we WALK THE LINKS, not seq:
--    start at the unique genesis (prev_hash IS NULL), then repeatedly follow the single row
--    whose prev_hash = the current row's row_hash, recomputing each row's hash with the SAME
--    canonicalization the trigger used. Detected breaks (returns the FIRST one, then stops):
--      - 'no genesis row (prev_hash IS NULL not found)'   => the head row was deleted, OR
--      - 'multiple genesis rows'                          => a forged/duplicated genesis, OR
--      - 'row_hash mismatch (content tampered)'           => a column value was mutated, OR
--      - 'fork: multiple rows chain onto this row_hash'   => a forged/inserted branch, OR
--      - 'unreachable rows (deletion/orphan break)'       => a mid-chain row was deleted
--        (its successor's prev_hash now matches nobody, so the walk ends early and some rows
--         are never visited).
--    Empty result set => the chain is intact end to end (every row reachable, all hashes
--    recompute, single genesis, single tail). regclass param so one function serves both
--    tables; recomputation branches on the table name to hash each table's exact columns
--    identically to its trigger. STABLE (reads only). cosmos_app needs only SELECT to run it.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_table regclass)
  RETURNS TABLE(broken_seq bigint, reason text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  prev bytea := NULL;        -- the STORED row_hash of the prior row in the walk
  recomputed bytea;
  tname text := p_table::text;
  total bigint;
  visited bigint := 0;
  genesis_count bigint;
  next_count int;
BEGIN
  IF tname NOT IN ('audit_logs', 'egress_decisions') THEN
    RAISE EXCEPTION 'verify_audit_chain: unsupported table %', tname
      USING ERRCODE = '22023';
  END IF;

  IF tname = 'audit_logs' THEN
    SELECT count(*) INTO total FROM "audit_logs";
    IF total = 0 THEN RETURN; END IF;  -- empty table => trivially intact

    SELECT count(*) INTO genesis_count FROM "audit_logs" WHERE prev_hash IS NULL;
    IF genesis_count = 0 THEN
      broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
    ELSIF genesis_count > 1 THEN
      broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
    END IF;

    -- Walk from genesis, following prev_hash -> row_hash links.
    SELECT * INTO r FROM "audit_logs" WHERE prev_hash IS NULL;
    LOOP
      visited := visited + 1;
      recomputed := digest(
        coalesce(prev, ''::bytea)
          || frame(r.seq::text)
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
      IF r.row_hash IS DISTINCT FROM recomputed THEN
        broken_seq := r.seq; reason := 'row_hash mismatch (content tampered)'; RETURN NEXT; RETURN;
      END IF;
      -- Fork detection: more than one row chains onto this row_hash.
      SELECT count(*) INTO next_count FROM "audit_logs" WHERE prev_hash = r.row_hash;
      IF next_count > 1 THEN
        broken_seq := r.seq; reason := 'fork: multiple rows chain onto this row_hash'; RETURN NEXT; RETURN;
      END IF;
      EXIT WHEN next_count = 0;  -- reached the tail
      prev := r.row_hash;
      SELECT * INTO r FROM "audit_logs" WHERE prev_hash = r.row_hash;
    END LOOP;

    IF visited <> total THEN
      broken_seq := NULL;
      reason := format('unreachable rows (deletion/orphan break): walked %s of %s', visited, total);
      RETURN NEXT; RETURN;
    END IF;
  ELSE
    SELECT count(*) INTO total FROM "egress_decisions";
    IF total = 0 THEN RETURN; END IF;

    SELECT count(*) INTO genesis_count FROM "egress_decisions" WHERE prev_hash IS NULL;
    IF genesis_count = 0 THEN
      broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
    ELSIF genesis_count > 1 THEN
      broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
    END IF;

    SELECT * INTO r FROM "egress_decisions" WHERE prev_hash IS NULL;
    LOOP
      visited := visited + 1;
      recomputed := digest(
        coalesce(prev, ''::bytea)
          || frame(r.seq::text)
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
      IF r.row_hash IS DISTINCT FROM recomputed THEN
        broken_seq := r.seq; reason := 'row_hash mismatch (content tampered)'; RETURN NEXT; RETURN;
      END IF;
      SELECT count(*) INTO next_count FROM "egress_decisions" WHERE prev_hash = r.row_hash;
      IF next_count > 1 THEN
        broken_seq := r.seq; reason := 'fork: multiple rows chain onto this row_hash'; RETURN NEXT; RETURN;
      END IF;
      EXIT WHEN next_count = 0;
      prev := r.row_hash;
      SELECT * INTO r FROM "egress_decisions" WHERE prev_hash = r.row_hash;
    END LOOP;

    IF visited <> total THEN
      broken_seq := NULL;
      reason := format('unreachable rows (deletion/orphan break): walked %s of %s', visited, total);
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  RETURN;  -- chain intact
END; $$;

-- 6. cosmos_app may EXECUTE the verify function (SELECT-only on the tables; no extra grant
--    needed for the trigger functions — they fire implicitly on INSERT as the inserting
--    role, which already has SELECT). EXECUTE on functions is granted to PUBLIC by default;
--    this is explicit + idempotent for auditability.
GRANT EXECUTE ON FUNCTION verify_audit_chain(regclass) TO cosmos_app;
GRANT EXECUTE ON FUNCTION frame(text) TO cosmos_app;
