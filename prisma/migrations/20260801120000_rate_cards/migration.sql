-- Rates become intervals instead of a single mutable number.
--
-- WHY. `employees.cost_rate` is one value with no dates on it, so changing it
-- rewrites the past: a pay run for March executed after an April raise prices
-- March at April's rate, and CLIN burn — measured against a funded ceiling —
-- moves whenever someone's pay changes. A rate is not a property of a person,
-- it is a value over a period.
--
-- `effective_from` INCLUSIVE, `effective_to` EXCLUSIVE, NULL open-ended, so
-- consecutive cards abut exactly: [Jan 1, Apr 1) then [Apr 1, NULL). No gap on
-- the boundary day, and no day covered twice.

CREATE TABLE "rate_cards" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"         UUID NOT NULL,
  "employee_id"    UUID NOT NULL,
  "cost_rate"      DECIMAL(19,4),
  "bill_rate"      DECIMAL(19,4),
  "currency"       TEXT NOT NULL DEFAULT 'USD',
  "effective_from" DATE NOT NULL,
  "effective_to"   DATE,
  "note"           TEXT,
  "created_by_id"  UUID NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CASCADE: a rate card is meaningless without the employee it prices, and the
-- employee row is itself never deleted casually (pay runs depend on it).
ALTER TABLE "rate_cards"
  ADD CONSTRAINT "rate_cards_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "rate_cards_org_id_employee_id_effective_from_idx"
  ON "rate_cards"("org_id", "employee_id", "effective_from");

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Every existing employee gets ONE open-ended card carrying their current rate.
--
-- The `effective_from` is the critical part. It must be early enough that EVERY
-- existing time entry still resolves to a rate — otherwise entries before it
-- would price at nothing, and CLIN burn / payroll totals would CHANGE the
-- moment this migration ran. The guarantee this migration must make is that
-- every historical figure is byte-identical afterwards.
--
-- So it is the earliest of: the employee's start date, their earliest time
-- entry, and the date their employee record was created. A rate that has
-- applied "since at least the first thing it prices" is both true and safe.
INSERT INTO "rate_cards" (
  "org_id", "employee_id", "cost_rate", "currency",
  "effective_from", "effective_to", "note", "created_by_id"
)
SELECT
  e."org_id",
  e."id",
  e."cost_rate",
  'USD',
  LEAST(
    COALESCE(e."start_date", e."created_at"::date),
    COALESCE(
      (SELECT MIN(te."date")::date
         FROM "time_entries" te
        WHERE te."user_id" = e."user_id"
          AND te."org_id"  = e."org_id"),
      e."created_at"::date
    ),
    e."created_at"::date
  ),
  NULL,                       -- open-ended: this IS the current rate
  'Imported from the employee record',
  e."created_by_id"
FROM "employees" e;
