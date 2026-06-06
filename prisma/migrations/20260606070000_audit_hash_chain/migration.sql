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

-- Index prev_hash: verify_audit_chain follows prev_hash -> row_hash links when walking the
-- chain (the trigger no longer needs this for tail discovery — see audit_chain_head below).
CREATE INDEX IF NOT EXISTS "audit_logs_prev_hash_idx"       ON "audit_logs" ("prev_hash");
CREATE INDEX IF NOT EXISTS "egress_decisions_prev_hash_idx" ON "egress_decisions" ("prev_hash");
-- Index row_hash: verify_audit_chain resolves each row's prev_hash -> the prior row by row_hash.
CREATE INDEX IF NOT EXISTS "audit_logs_row_hash_idx"        ON "audit_logs" ("row_hash");
CREATE INDEX IF NOT EXISTS "egress_decisions_row_hash_idx"  ON "egress_decisions" ("row_hash");

-- 2b. O(1) chain-head pointer state table (Defect 1 fix — scalability).
--    The original trigger discovered the chain TAIL with a NOT EXISTS anti-join over the
--    WHOLE table on every insert: O(n) per insert, O(n²) over the table's life, under a
--    global advisory lock. At gov audit volume (millions of rows over 1095-day retention)
--    that degrades to seconds per insert and chokes the fire-and-forget audit write path.
--
--    Instead we keep the current chain head (the tail's row_hash) in a tiny MUTABLE state
--    table, one row per audited table. The trigger reads + advances it in O(1) under a
--    `SELECT ... FOR UPDATE` row lock that BOTH reads the head AND serializes chain
--    extension (so two concurrent inserts cannot bind the same head => no FORK).
--
--    IMPORTANT — this is NOT an audit table. The 20260606050000 append-only guards
--    (UPDATE/DELETE/TRUNCATE blocked) do NOT apply to it; it is INTENTIONALLY mutable
--    because the trigger UPDATEs head_hash on every insert. It is also NOT security-critical:
--    tampering with audit_chain_head can only MIS-LINK FUTURE rows (a wrong prev_hash), which
--    verify_audit_chain still detects as a fork / row_hash mismatch when it recomputes from
--    the audit rows. The audit ROWS remain the sole source of truth; the head table is just a
--    cache of "where the tail is" so the trigger need not rediscover it by table scan.
--
--    head_hash starts NULL for both tables. On a fresh DB the first insert sees NULL =>
--    genesis. On a NON-FRESH DB that already had legacy unhashed rows (row_hash IS NULL,
--    written before 2.6.0), head_hash is STILL NULL, so the first post-migration insert is a
--    clean genesis of the NEW chain — independent of the legacy rows (Defect 2, trigger side).
CREATE TABLE IF NOT EXISTS "audit_chain_head" (
  "table_name" text PRIMARY KEY,
  "head_hash"  bytea
);
INSERT INTO "audit_chain_head" ("table_name", "head_hash")
  VALUES ('audit_logs', NULL), ('egress_decisions', NULL)
  ON CONFLICT ("table_name") DO NOTHING;
-- The trigger runs as the inserting role (cosmos_app), so cosmos_app needs SELECT + UPDATE on
-- this state row. (ALTER DEFAULT PRIVILEGES from 20260606050000 may already cover an
-- owner-created table, but GRANT explicitly + idempotently — and this table is deliberately
-- EXCLUDED from the audit-table REVOKE of UPDATE, since the trigger must UPDATE it.)
GRANT SELECT, UPDATE ON "audit_chain_head" TO cosmos_app;

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

-- 4. Per-table BEFORE INSERT hash-chain trigger functions.  ★ O(1) HEAD-POINTER DESIGN ★
--    - prev := the current chain head (the tail's row_hash), read from the audit_chain_head
--      state row in O(1) via `SELECT head_hash ... FOR UPDATE`. NULL => genesis.
--    - The `FOR UPDATE` row lock is the REAL serializer: it both READS the current head AND
--      blocks any concurrent insert on the same table from reading/advancing it until this
--      txn commits, so two concurrent fire-and-forget inserts cannot bind the same head
--      (a FORK). It replaces the old whole-table NOT EXISTS anti-join (which was O(n) per
--      insert => O(n²) over the table's life, the Defect 1 scalability bug). We KEEP the
--      per-table advisory lock as belt-and-suspenders, but the FOR UPDATE on the state row
--      is what guarantees a single linear chain.
--    - row_hash := sha256( coalesce(prev,'') || frame(every persisted column) ) — computed
--      BYTE-FOR-BYTE IDENTICALLY to before (same frame() helper, same column order, same
--      coalesce(prev,'') prefix). Only the MECHANISM for discovering `prev` changed; the
--      hash VALUE for a given (prev, row) is unchanged, so verify_audit_chain — which
--      recomputes from the stored rows — stays fully compatible.
--    - After hashing, advance the head: UPDATE audit_chain_head SET head_hash = NEW.row_hash.
--
--    *** WHY A HEAD POINTER, NOT A TABLE SCAN OR `ORDER BY seq DESC` ***
--    A GENERATED ALWAYS AS IDENTITY `seq` is allocated when the tuple is FORMED, BEFORE the
--    BEFORE-INSERT trigger fires and OUTSIDE the serializer, so seq order need NOT match
--    chain-extension order under concurrency (selecting by `ORDER BY seq DESC` produced an
--    empirically-observed 8-fork failure on 200 parallel inserts). The head pointer sidesteps
--    seq entirely: the FOR UPDATE-locked state row holds the one true tail at all times, so
--    the chain stays strictly linear regardless of seq-vs-lock ordering — and it is O(1).
--    The chain is thus a LINKED LIST; verify_audit_chain walks it by following prev_hash
--    links from genesis, NOT by seq (seq order may legitimately differ from chain order).
--
--    NOTE on NEW.seq: it is included as frame(NEW.seq::text) to cryptographically bind each
--    row to its monotonic id (immutable via the append-only guard + unique index) — but it
--    is NOT used to ORDER the chain (see above). The verifier reads each row's own stored
--    seq, so this is replay-stable.
--
--    NOTE on legacy rows (Defect 2, trigger side): head_hash starts NULL even on a table that
--    already contains pre-2.6.0 rows with row_hash IS NULL, so the FIRST post-migration
--    insert is a clean genesis (prev = NULL) of the NEW chain, independent of those legacy
--    rows. verify_audit_chain scopes the chain to row_hash IS NOT NULL (see §5).
--    No SECURITY DEFINER: the trigger SELECTs the inserted table + the head state row and
--    UPDATEs the head row — cosmos_app has SELECT on the audit table and SELECT+UPDATE on
--    audit_chain_head (granted above) — no elevated privilege required.

-- audit_logs: columns id, org_id, user_id, action, entity, entity_id, metadata,
--             ip_address, created_at.
CREATE OR REPLACE FUNCTION audit_logs_hash_chain() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(491000001);
  -- O(1) head read + serialize: FOR UPDATE locks the state row so concurrent inserts can't
  -- bind the same head. NULL => genesis (fresh DB, or first insert after a non-fresh upgrade).
  SELECT head_hash INTO prev FROM "audit_chain_head"
    WHERE table_name = 'audit_logs' FOR UPDATE;
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
  -- Advance the head pointer to the row we just sealed. O(1).
  UPDATE "audit_chain_head" SET head_hash = NEW.row_hash WHERE table_name = 'audit_logs';
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
  -- O(1) head read + serialize (see audit_logs_hash_chain for the rationale).
  SELECT head_hash INTO prev FROM "audit_chain_head"
    WHERE table_name = 'egress_decisions' FOR UPDATE;
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
  -- Advance the head pointer to the row we just sealed. O(1).
  UPDATE "audit_chain_head" SET head_hash = NEW.row_hash WHERE table_name = 'egress_decisions';
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
--
--    ★ DEFECT 2 (non-fresh DBs): the chain is scoped to HASHED rows only. ★
--    On a DB that already had audit rows BEFORE this migration (e.g. an existing v2 instance
--    upgrading 2.5.0 -> 2.6.0), those legacy rows have BOTH row_hash IS NULL AND prev_hash IS
--    NULL. A naive `prev_hash IS NULL` genesis count would see every legacy row as a genesis
--    and FALSELY report "multiple genesis rows". So we define the chain over
--    `row_hash IS NOT NULL` only: total = count(row_hash IS NOT NULL); genesis = the row with
--    prev_hash IS NULL AND row_hash IS NOT NULL (the first row written after the migration).
--    Legacy rows (row_hash IS NULL) are PRE-CHAIN and ignored here — they are still covered by
--    the append-only guards (layer 1) and the offsite WORM anchor (layer 3). The chain
--    anchors at the first post-2.6.0 row. (The cutover applies migrations to a fresh DB, so
--    that path has no legacy rows and is unaffected.)
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
    -- Scope to HASHED rows only (Defect 2): legacy pre-2.6.0 rows have row_hash IS NULL and
    -- are outside the chain. An all-legacy (or empty) table => no chain yet => trivially intact.
    SELECT count(*) INTO total FROM "audit_logs" WHERE row_hash IS NOT NULL;
    IF total = 0 THEN RETURN; END IF;

    -- Genesis = the hashed row with no predecessor. Legacy rows (row_hash IS NULL) are excluded
    -- so they do NOT masquerade as extra geneses.
    SELECT count(*) INTO genesis_count FROM "audit_logs" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
    IF genesis_count = 0 THEN
      broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
    ELSIF genesis_count > 1 THEN
      broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
    END IF;

    -- Walk from genesis, following prev_hash -> row_hash links.
    SELECT * INTO r FROM "audit_logs" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
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
    -- Scope to HASHED rows only (Defect 2); legacy pre-2.6.0 rows (row_hash IS NULL) excluded.
    SELECT count(*) INTO total FROM "egress_decisions" WHERE row_hash IS NOT NULL;
    IF total = 0 THEN RETURN; END IF;

    SELECT count(*) INTO genesis_count FROM "egress_decisions" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
    IF genesis_count = 0 THEN
      broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
    ELSIF genesis_count > 1 THEN
      broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
    END IF;

    SELECT * INTO r FROM "egress_decisions" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
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
