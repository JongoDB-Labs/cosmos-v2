-- Billed hours: what the client pays for, decided separately from what was logged.
--
-- Nullable with NO default, deliberately. NULL means "bill what was logged", so
-- every existing row keeps billing exactly as it does today and no backfill is
-- needed. Defaulting to `hours` would instead freeze a copy that drifts the
-- first time anyone edits the entry.
ALTER TABLE "time_entries" ADD COLUMN "billed_hours" DOUBLE PRECISION;
ALTER TABLE "time_entries" ADD COLUMN "billed_by_id" UUID;
ALTER TABLE "time_entries" ADD COLUMN "billed_at" TIMESTAMP(3);

-- Reads that total billed hours filter on the entries that carry a decision.
CREATE INDEX "time_entries_org_id_billed_at_idx" ON "time_entries" ("org_id", "billed_at");
