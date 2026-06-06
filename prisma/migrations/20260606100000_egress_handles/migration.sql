-- Opaque-handle resolver store (AC-4 / 3.1.3 — controlled CUI-by-reference flow).
--
-- WHAT: a conversation-scoped, sealed-at-rest store mapping an unguessable token
-- (`h:<base64url(18 random bytes)>`, ≥144 bits) to a vault-sealed CUI value. When
-- the egress gate WITHHOLDS a CUI field from the CUI-blind model, we mint a token,
-- hand the model the TOKEN (never the value), and resolve it back to the real value
-- IN-BOUNDARY before the executor runs. The model orchestrates CUI it never reads.
--
-- SECURITY POSTURE:
--   - `value_enc` is a vault envelope (v2.<kid>.<iv>.<tag>.<ct>, AES-256-GCM) — the
--     plaintext CUI NEVER touches the DB (SC-28 / 800-171 3.13.16 protect-at-rest).
--   - `token` is UNIQUE + random; resolution verifies `conversation_id` match in
--     code (a token from conversation A must NOT resolve in B — cross-conversation /
--     cross-tenant isolation; the conversation is the boundary, mirroring how
--     egress_decisions correlate by conversation_id and carry NO cross-cutting FK).
--   - This is NOT an audit table. The AC-4 trail (mint/resolve EVENTS) lives in the
--     append-only egress_decisions table; this store only holds the sealed value +
--     metadata, and is INTENTIONALLY mutable/deletable for the TTL cleanup sweep
--     (bounded lifetime — sealed CUI must not accumulate). So cosmos_app keeps full
--     DML here (INSERT/SELECT/DELETE), unlike the audit tables.
--
-- LIFETIME / CLEANUP (AU-11 bounded retention): handles are conversation-scoped and
-- short-lived. The `created_at` index supports a periodic sweep:
--     DELETE FROM "egress_handles" WHERE "created_at" < now() - interval '<ttl>';
-- run from the retention job (least-privilege: cosmos_app, the same role the loop
-- mints/resolves under). See docs/runbooks (retention) for the cadence.
--
-- Hand-written (no dev DB / `prisma migrate dev`); applied via `prisma migrate
-- deploy` as the OWNER (cosmos). Idempotent (IF NOT EXISTS) so a re-applied deploy
-- is a no-op. cosmos_app DML is auto-granted by the 20260606050000 ALTER DEFAULT
-- PRIVILEGES (owner-created tables grant SELECT/INSERT/UPDATE/DELETE to cosmos_app);
-- we GRANT explicitly + idempotently below so the posture is self-documenting and
-- does not depend on default-privilege ordering.

CREATE TABLE IF NOT EXISTS "egress_handles" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "value_enc"       TEXT NOT NULL,
  "entity_type"     TEXT NOT NULL,
  "field_name"      TEXT NOT NULL,
  -- MAC-binding: the data-classification CEILING the value was WITHHELD under at MINT
  -- time (e.g. "CUI"), stored as the ClassificationLevel string. C1 fix: a handle minted
  -- under a HIGH ceiling MUST re-gate its RESOLVING turn at ≥ that ceiling — otherwise a
  -- value withheld at CUI on a project-scoped turn could be resolved-and-echoed on a
  -- later no-projectId turn that re-gates at the (lower) org ceiling and EXPOSES it.
  -- resolveHandle returns this so the loop folds it into the result's effective ceiling
  -- (max-by-rank) BEFORE projectForModel — forcing withhold for BOTH tenants. NULLable
  -- (back-compat / fail-safe): a null ceiling does not LOWER any gate, it simply adds no
  -- floor. The TTL sweep / metadata semantics are unchanged.
  "ceiling"         TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "egress_handles_pkey" PRIMARY KEY ("id")
);

-- Idempotent column add for the case where the table already exists from an earlier
-- application of THIS (unreleased) migration without the ceiling column.
ALTER TABLE "egress_handles" ADD COLUMN IF NOT EXISTS "ceiling" TEXT;

-- Unforgeable lookup key: the token is globally unique (findUnique({token})).
CREATE UNIQUE INDEX IF NOT EXISTS "egress_handles_token_key"
  ON "egress_handles" ("token");

-- Conversation scope: resolve filters/verifies by conversation_id; cleanup sweeps by it.
CREATE INDEX IF NOT EXISTS "egress_handles_conversation_id_idx"
  ON "egress_handles" ("conversation_id");

-- TTL sweep support: DELETE ... WHERE created_at < now() - interval '<ttl>'.
CREATE INDEX IF NOT EXISTS "egress_handles_created_at_idx"
  ON "egress_handles" ("created_at");

-- Least-privilege DML for the app role (NOT an audit table → DELETE allowed for the
-- TTL cleanup). Explicit + idempotent; complements the ALTER DEFAULT PRIVILEGES grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON "egress_handles" TO cosmos_app;
