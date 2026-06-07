-- ════════════════════════════════════════════════════════════════════════════
-- COLUMN PARITY (§9.2 cutover prerequisite — column-level reconciliation)
--
-- Adds the per-column gaps the live prod DB (cosmos @ 127.0.0.1:5432) has but v2
-- was missing on already-shared tables, so the per-tenant cutover copies prod
-- VALUES into a structurally-identical v2 schema with ZERO data loss. SHAPE
-- matches prod EXACTLY (type / nullability / default), verified against prod's
-- information_schema.columns + pg_constraint + pg_indexes.
--
-- Populated-in-prod (real data the cutover MUST carry):
--   work_items.{external_id,external_key,external_source,source_record,
--               source_status}     — 964/1012 rows
--   org_security_settings.*        — 2/2 rows
--   boards.slug                    — 12/12 rows
--   chat_channel_members.pinned    — 16/16 rows (all currently false)
-- All-NULL-in-prod but added for shape parity / lossless re-import:
--   work_items.{original_estimate,remaining_estimate,resolution,time_spent}
--   users.{custom_status,custom_status_emoji,dnd_until_at}
--   time_entries.pay_run_id
--
-- Hand-written (no `prisma migrate dev`); applied via `migrate deploy`. Idempotent
-- (ADD COLUMN / CREATE INDEX IF NOT EXISTS). cosmos_app already holds DML on these
-- tables — no new grant needed.
--
-- ── INTENTIONAL DEVIATIONS — prod columns deliberately NOT added here ──────────
--   users.google_refresh_token        v2 dropped it (migration
--                                      20260606120000_drop_google_refresh_token);
--                                      sealed ConnectorCredential vault is the sole
--                                      source of truth — the 3 users re-auth at
--                                      login. NOT re-added.
--   mcp_servers.env / .headers        v2 replaced with sealed env_enc / headers_enc
--                                      (v2.12). Prod has 0 mcp_servers rows, so no
--                                      data to carry. NOT added.
--   chat_message_attachments.classification_level
--                                      ClassificationLevel enum column; prod table
--                                      is EMPTY (0 rows) so all-NULL/no data. v2
--                                      models classification its own way. Skipped.
--   work_items.content_tsv / search_vector (and any *_tsv / search_vector)
--                                      v2 handles full-text/semantic search its own
--                                      way (pgvector embedding + native FTS). Skipped.
-- ════════════════════════════════════════════════════════════════════════════

-- ── work_items: superset / import-provenance fields ──────────────────────────
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "external_source" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "external_key" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "source_status" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "resolution" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "source_record" JSONB;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "original_estimate" INTEGER;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "remaining_estimate" INTEGER;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "time_spent" INTEGER;

-- Idempotent re-import key (prod: work_items_org_id_external_source_external_id_key).
-- NULLs are distinct in Postgres, so this coexists with the 48 not-yet-imported rows.
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_org_id_external_source_external_id_key"
  ON "work_items" ("org_id", "external_source", "external_id");

-- ── org_security_settings: session policy + MFA readiness + action restrictions ─
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "max_session_age_mins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "idle_timeout_mins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "max_concurrent_sessions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "mfa_enrollment_ready" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "action_restrictions" JSONB NOT NULL DEFAULT '{}';

-- ── boards: per-project URL slug (prod: boards_project_id_slug_key) ───────────
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "slug" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "boards_project_id_slug_key"
  ON "boards" ("project_id", "slug");

-- ── chat_channel_members: per-user channel pin ───────────────────────────────
ALTER TABLE "chat_channel_members" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;

-- ── users: presence / availability (cosmetic, mostly NULL) ───────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status_emoji" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dnd_until_at" TIMESTAMP(3);

-- ── time_entries: pay-run linkage ────────────────────────────────────────────
-- Plain UUID scalar, NO foreign key — matches prod EXACTLY (prod's
-- time_entries.pay_run_id carries no FK constraint and prod's Prisma defines it as
-- a bare scalar, not a PayRun relation). All-NULL in prod today.
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "pay_run_id" UUID;
