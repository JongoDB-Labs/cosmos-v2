-- The audit spine for timekeeping: pay periods, an append-only revision
-- history, and void-instead-of-delete.
--
-- WHY. Time entries were approvable one at a time, editable with only a record
-- that "hours changed" (never from what to what), and DELETABLE. A dataset with
-- hard deletes is inadmissible: an auditor cannot distinguish "never entered"
-- from "removed after the fact". These three tables/columns are what turn the
-- entries into evidence.
--
-- SAFETY. Entirely additive. Every new column is nullable, every new table is
-- empty until written to, and the backfill at the bottom only ever INSERTs
-- timesheets and sets `timesheet_id` — no existing column is altered and no row
-- is deleted. An org that never touches the new surfaces sees no change.

-- ── Pay periods ──────────────────────────────────────────────────────────────
CREATE TYPE "TimesheetStatus" AS ENUM (
  'OPEN', 'SUBMITTED', 'LABOR_APPROVED', 'APPROVED', 'REJECTED', 'LOCKED'
);

CREATE TABLE "timesheets" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"                UUID NOT NULL,
  "user_id"               UUID NOT NULL,
  "period_start"          DATE NOT NULL,
  "period_end"            DATE NOT NULL,
  "status"                "TimesheetStatus" NOT NULL DEFAULT 'OPEN',
  "submitted_at"          TIMESTAMP(3),
  "labor_approved_by_id"  UUID,
  "labor_approved_at"     TIMESTAMP(3),
  "cost_approved_by_id"   UUID,
  "cost_approved_at"      TIMESTAMP(3),
  "rejected_reason"       TEXT,
  "attested_at"           TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- One timesheet per person per period. This is what makes the lazy upsert on
-- first entry safe under concurrency: two simultaneous creates race to INSERT
-- and the loser takes the winner's row instead of creating a duplicate.
CREATE UNIQUE INDEX "timesheets_org_id_user_id_period_start_key"
  ON "timesheets"("org_id", "user_id", "period_start");
CREATE INDEX "timesheets_org_id_status_idx" ON "timesheets"("org_id", "status");

-- ── Revision history ─────────────────────────────────────────────────────────
CREATE TABLE "time_entry_revisions" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"        UUID NOT NULL,
  "time_entry_id" UUID NOT NULL,
  "previous"      JSONB NOT NULL,
  "changed"       JSONB NOT NULL,
  "reason"        TEXT,
  "actor_id"      UUID NOT NULL,
  "actor_ip"      TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "time_entry_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "time_entry_revisions_org_id_time_entry_id_created_at_idx"
  ON "time_entry_revisions"("org_id", "time_entry_id", "created_at");

-- CASCADE is deliberate and is NOT a hard-delete path: entries are voided, not
-- deleted, so this only fires if a row is removed administratively — in which
-- case orphaned revisions pointing at nothing would be worse than none.
ALTER TABLE "time_entry_revisions"
  ADD CONSTRAINT "time_entry_revisions_time_entry_id_fkey"
  FOREIGN KEY ("time_entry_id") REFERENCES "time_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Time entries: period link + void ────────────────────────────────────────
ALTER TABLE "time_entries" ADD COLUMN "timesheet_id" UUID;
ALTER TABLE "time_entries" ADD COLUMN "voided_at"    TIMESTAMP(3);
ALTER TABLE "time_entries" ADD COLUMN "voided_by_id" UUID;
ALTER TABLE "time_entries" ADD COLUMN "void_reason"  TEXT;

-- SET NULL, not CASCADE: deleting a timesheet must never take the hours with
-- it. An orphaned entry is visible and repairable; a deleted one is gone.
ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_timesheet_id_fkey"
  FOREIGN KEY ("timesheet_id") REFERENCES "timesheets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "time_entries_timesheet_id_idx" ON "time_entries"("timesheet_id");
-- Every read filters voided rows out, so it belongs in the index.
CREATE INDEX "time_entries_org_id_user_id_voided_at_idx"
  ON "time_entries"("org_id", "user_id", "voided_at");

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Existing entries get the WEEKLY period they already belong to. Postgres
-- `date_trunc('week', ...)` is ISO — it returns MONDAY — which is exactly the
-- definition in lib/time/period.ts. If those two ever disagree, entries would
-- be filed against a period the application cannot compute.
INSERT INTO "timesheets" ("org_id", "user_id", "period_start", "period_end", "status", "updated_at")
SELECT DISTINCT
  te."org_id",
  te."user_id",
  (date_trunc('week', te."date"))::date,
  (date_trunc('week', te."date") + interval '6 days')::date,
  -- Explicit cast: a bare 'OPEN' in an INSERT ... SELECT infers as `text` and
  -- Postgres refuses to assign it to the enum column (42804).
  'OPEN'::"TimesheetStatus",
  CURRENT_TIMESTAMP
FROM "time_entries" te
ON CONFLICT ("org_id", "user_id", "period_start") DO NOTHING;

-- Status stays OPEN even where the entries are already APPROVED. Marking a
-- timesheet approved because its entries are would INVENT an approval that
-- nobody gave — the worst possible row to fabricate in an audit trail. Entry
-- status remains authoritative until the timesheet workflow exists.
UPDATE "time_entries" te
SET "timesheet_id" = ts."id"
FROM "timesheets" ts
WHERE ts."org_id" = te."org_id"
  AND ts."user_id" = te."user_id"
  AND ts."period_start" = (date_trunc('week', te."date"))::date
  AND te."timesheet_id" IS NULL;
