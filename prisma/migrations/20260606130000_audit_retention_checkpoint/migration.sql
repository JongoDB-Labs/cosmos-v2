-- AU-11 audit RETENTION-PURGE chain-checkpoint.
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate deploy`
-- as the OWNER (cosmos). Empirically verified on a real PG16 cluster (see
-- docs/runbooks/audit-integrity.md for the pasted proof matrix).
--
-- WHY: gov over-retains (audit retention >= 1095 days), and the AU-9 hash-chain
-- (20260606070000_audit_hash_chain) today anchors verification at GENESIS
-- (prev_hash IS NULL). When a sanctioned retention-purge eventually deletes the OLDEST
-- rows (the head of the chain), the genesis row disappears and a naive
-- verify_audit_chain() would FALSELY report "no genesis row (head deleted)". This
-- migration closes that gap so a purge can happen WITHOUT breaking tamper-evidence:
--
--   1. A new `audit_chain_checkpoint` table records, at each purge boundary, the
--      `checkpoint_seq` (= N, the max seq purged) and the `checkpoint_row_hash`
--      (= the row_hash of the row AT seq N, i.e. the last purged row). It is HMAC-signed
--      (the sig is verified by the JS wrapper scripts/dsop/verify-audit-chain.mjs — a SQL
--      function can't read the HMAC key from env). The LATEST checkpoint per table (max
--      checkpoint_seq) is the active anchor.
--
--   2. verify_audit_chain() is REPLACEd to be checkpoint-aware: it anchors the walk at
--      EITHER a genesis (no checkpoint yet — the unchanged behavior) OR, when a checkpoint
--      exists, at the first RETAINED row whose prev_hash == the latest checkpoint's
--      checkpoint_row_hash (the link the trigger wrote BEFORE the purged row was deleted
--      SURVIVES the delete, because it lives on the *retained* successor row). The walk then
--      proceeds exactly as before: follow prev_hash -> row_hash links to the tail,
--      recomputing each hash, scoped to retained rows (row_hash IS NOT NULL AND, when a
--      checkpoint exists, seq > checkpoint_seq).
--
-- THE PURGE ITSELF (scripts/dsop/purge-audit.mjs) runs as the OWNER with
-- `SET LOCAL session_replication_role = replica` in ONE transaction — the ONLY sanctioned
-- path that bypasses the 20260606050000 append-only trigger. cosmos_app STILL cannot delete
-- audit rows (the REVOKE + the trigger are untouched by this migration). The purged prefix
-- was WORM-anchored offsite FIRST (the purge refuses if N > the latest WORM toSeq), so the
-- deleted rows remain tamper-evident via the offsite copy + the signed checkpoint.
--
-- This migration is IDEMPOTENT (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
-- DROP-then-CREATE indexes). It does NOT modify the existing hash-chain or append-only
-- migrations; it only ADDS the checkpoint table and REPLACES verify_audit_chain via
-- CREATE OR REPLACE (the trigger functions + the seal formula are unchanged).

-- ── 1. The signed chain-checkpoint table ──────────────────────────────────────────────
-- One row per purge, per table. Append-only-ish like the audit tables themselves: cosmos_app
-- gets SELECT (verify_audit_chain reads it, and the JS wrapper SELECTs the latest sig), but
-- NO UPDATE/DELETE/TRUNCATE (a forged/altered checkpoint must be detectable, not silently
-- editable by the app). Only the OWNER inserts here (during a purge). NOT covered by the
-- audit-table append-only trigger (that trigger is attached to audit_logs / egress_decisions
-- only) — the REVOKE below is what keeps the app out.
CREATE TABLE IF NOT EXISTS "audit_chain_checkpoint" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "table_name"          text   NOT NULL,
  "checkpoint_seq"      bigint NOT NULL,
  "checkpoint_row_hash" bytea  NOT NULL,
  "sig"                 bytea  NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_chain_checkpoint_table_chk"
    CHECK ("table_name" IN ('audit_logs', 'egress_decisions'))
);

-- Latest-per-table lookup: verify_audit_chain + the purge script + the JS wrapper all need
-- "the active checkpoint" = MAX(checkpoint_seq) for a table. A DESC index on
-- (table_name, checkpoint_seq) makes that an index-only top-1.
CREATE INDEX IF NOT EXISTS "audit_chain_checkpoint_table_seq_idx"
  ON "audit_chain_checkpoint" ("table_name", "checkpoint_seq" DESC);

-- Append-only posture for the app role (mirrors the audit-table REVOKE in 20260606050000).
-- The owner (cosmos) created the table so already owns it; cosmos_app needs SELECT only.
GRANT SELECT ON "audit_chain_checkpoint" TO cosmos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_chain_checkpoint" FROM cosmos_app;

-- ── 2. Checkpoint-aware verify_audit_chain (REPLACE) ──────────────────────────────────
-- STRUCTURAL anchor only (the HMAC sig is verified in the JS wrapper, which CAN read env):
--   * No checkpoint for the table  => anchor at genesis (prev_hash IS NULL AND
--     row_hash IS NOT NULL), total = count(row_hash IS NOT NULL). Identical to before.
--   * A checkpoint exists          => let cp = the LATEST (max checkpoint_seq) checkpoint.
--     Retained window = (row_hash IS NOT NULL AND seq > cp.checkpoint_seq). Anchor = the
--     UNIQUE retained row whose prev_hash = cp.checkpoint_row_hash (the surviving link to
--     the purged tail). Walk forward from there exactly as the genesis path does.
--     Detected breaks in the checkpoint case:
--       - 'no row anchors at checkpoint (first retained row missing/altered)' : 0 such rows
--       - 'multiple rows anchor at checkpoint (fork at boundary)'             : >1 such rows
--       - 'row_hash mismatch (content tampered)'   (recompute fails)
--       - 'fork: multiple rows chain onto this row_hash'
--       - 'unreachable rows (deletion/orphan break)' (walked <> retained total)
--   Empty result set => intact end to end. (The wrapper additionally checks the sig.)
--
-- regclass param so one function serves both tables; recomputation branches on the table
-- name to hash each table's exact columns identically to its BEFORE INSERT trigger. STABLE
-- (reads only). cosmos_app needs SELECT on the audit tables + the checkpoint table (granted
-- above) + EXECUTE (re-granted at the end).
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
  next_count int;
  anchor_count int;
  cp_seq  bigint;            -- latest checkpoint_seq for this table (NULL => no checkpoint)
  cp_hash bytea;             -- latest checkpoint_row_hash
BEGIN
  IF tname NOT IN ('audit_logs', 'egress_decisions') THEN
    RAISE EXCEPTION 'verify_audit_chain: unsupported table %', tname
      USING ERRCODE = '22023';
  END IF;

  -- The active checkpoint for this table (highest checkpoint_seq), if any.
  SELECT c.checkpoint_seq, c.checkpoint_row_hash
    INTO cp_seq, cp_hash
    FROM "audit_chain_checkpoint" c
    WHERE c.table_name = tname
    ORDER BY c.checkpoint_seq DESC
    LIMIT 1;

  IF tname = 'audit_logs' THEN
    IF cp_seq IS NULL THEN
      -- ── No checkpoint: classic genesis-anchored walk (Defect-2 scoped to hashed rows) ──
      SELECT count(*) INTO total FROM "audit_logs" WHERE row_hash IS NOT NULL;
      IF total = 0 THEN RETURN; END IF;

      SELECT count(*) INTO anchor_count FROM "audit_logs" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
      IF anchor_count = 0 THEN
        broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
      ELSIF anchor_count > 1 THEN
        broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
      END IF;
      SELECT * INTO r FROM "audit_logs" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
    ELSE
      -- ── Checkpoint-anchored walk: retained window = row_hash IS NOT NULL AND seq > cp_seq ──
      SELECT count(*) INTO total FROM "audit_logs" WHERE row_hash IS NOT NULL AND seq > cp_seq;
      IF total = 0 THEN RETURN; END IF;  -- everything purged up to the checkpoint; nothing retained.

      -- The anchor is the unique retained row that linked onto the (now-purged) checkpoint row.
      SELECT count(*) INTO anchor_count
        FROM "audit_logs" WHERE row_hash IS NOT NULL AND seq > cp_seq AND prev_hash = cp_hash;
      IF anchor_count = 0 THEN
        broken_seq := NULL; reason := 'no row anchors at checkpoint (first retained row missing/altered)'; RETURN NEXT; RETURN;
      ELSIF anchor_count > 1 THEN
        broken_seq := NULL; reason := 'multiple rows anchor at checkpoint (fork at boundary)'; RETURN NEXT; RETURN;
      END IF;
      SELECT * INTO r FROM "audit_logs" WHERE row_hash IS NOT NULL AND seq > cp_seq AND prev_hash = cp_hash;
      prev := cp_hash;  -- recompute the anchor row's hash WITH the checkpoint hash as its prev.
    END IF;

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
      -- Fork detection scoped to the retained window (a purged row can't be a "next").
      SELECT count(*) INTO next_count FROM "audit_logs"
        WHERE prev_hash = r.row_hash AND row_hash IS NOT NULL
          AND (cp_seq IS NULL OR seq > cp_seq);
      IF next_count > 1 THEN
        broken_seq := r.seq; reason := 'fork: multiple rows chain onto this row_hash'; RETURN NEXT; RETURN;
      END IF;
      EXIT WHEN next_count = 0;  -- reached the tail
      prev := r.row_hash;
      SELECT * INTO r FROM "audit_logs"
        WHERE prev_hash = r.row_hash AND row_hash IS NOT NULL
          AND (cp_seq IS NULL OR seq > cp_seq);
    END LOOP;

    IF visited <> total THEN
      broken_seq := NULL;
      reason := format('unreachable rows (deletion/orphan break): walked %s of %s', visited, total);
      RETURN NEXT; RETURN;
    END IF;
  ELSE
    -- ── egress_decisions ──
    IF cp_seq IS NULL THEN
      SELECT count(*) INTO total FROM "egress_decisions" WHERE row_hash IS NOT NULL;
      IF total = 0 THEN RETURN; END IF;

      SELECT count(*) INTO anchor_count FROM "egress_decisions" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
      IF anchor_count = 0 THEN
        broken_seq := NULL; reason := 'no genesis row (head deleted)'; RETURN NEXT; RETURN;
      ELSIF anchor_count > 1 THEN
        broken_seq := NULL; reason := 'multiple genesis rows (forged/duplicated genesis)'; RETURN NEXT; RETURN;
      END IF;
      SELECT * INTO r FROM "egress_decisions" WHERE prev_hash IS NULL AND row_hash IS NOT NULL;
    ELSE
      SELECT count(*) INTO total FROM "egress_decisions" WHERE row_hash IS NOT NULL AND seq > cp_seq;
      IF total = 0 THEN RETURN; END IF;

      SELECT count(*) INTO anchor_count
        FROM "egress_decisions" WHERE row_hash IS NOT NULL AND seq > cp_seq AND prev_hash = cp_hash;
      IF anchor_count = 0 THEN
        broken_seq := NULL; reason := 'no row anchors at checkpoint (first retained row missing/altered)'; RETURN NEXT; RETURN;
      ELSIF anchor_count > 1 THEN
        broken_seq := NULL; reason := 'multiple rows anchor at checkpoint (fork at boundary)'; RETURN NEXT; RETURN;
      END IF;
      SELECT * INTO r FROM "egress_decisions" WHERE row_hash IS NOT NULL AND seq > cp_seq AND prev_hash = cp_hash;
      prev := cp_hash;
    END IF;

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
      SELECT count(*) INTO next_count FROM "egress_decisions"
        WHERE prev_hash = r.row_hash AND row_hash IS NOT NULL
          AND (cp_seq IS NULL OR seq > cp_seq);
      IF next_count > 1 THEN
        broken_seq := r.seq; reason := 'fork: multiple rows chain onto this row_hash'; RETURN NEXT; RETURN;
      END IF;
      EXIT WHEN next_count = 0;
      prev := r.row_hash;
      SELECT * INTO r FROM "egress_decisions"
        WHERE prev_hash = r.row_hash AND row_hash IS NOT NULL
          AND (cp_seq IS NULL OR seq > cp_seq);
    END LOOP;

    IF visited <> total THEN
      broken_seq := NULL;
      reason := format('unreachable rows (deletion/orphan break): walked %s of %s', visited, total);
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  RETURN;  -- chain intact
END; $$;

-- cosmos_app may EXECUTE the (replaced) verify function; re-grant idempotently.
GRANT EXECUTE ON FUNCTION verify_audit_chain(regclass) TO cosmos_app;
