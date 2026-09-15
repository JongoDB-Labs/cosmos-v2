-- Effective-dated employee cost rates.
--
-- Until now `employees.cost_rate` was a single scalar, so costing an hour used
-- whatever the rate is TODAY no matter when the hour was worked. A raise
-- retroactively rewrote every margin already reported — including phases closed
-- months earlier.
--
-- The rate for a date is the row with the greatest `effective_from` on or before
-- it. There is deliberately no `effective_to`: a closed interval has to be kept
-- consistent on every write, and both ways it goes wrong are silent and land in
-- money — a gap prices an hour at nothing, an overlap prices it twice.

-- CreateTable
CREATE TABLE "employee_cost_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "cost_rate" DECIMAL(19,4) NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_cost_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_cost_rates_org_id_employee_id_effective_from_idx" ON "employee_cost_rates"("org_id", "employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "employee_cost_rates_employee_id_effective_from_key" ON "employee_cost_rates"("employee_id", "effective_from");

-- AddForeignKey
ALTER TABLE "employee_cost_rates" ADD CONSTRAINT "employee_cost_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one row per employee, at a floor earlier than any hour anyone could
-- have logged. That is what makes this migration move no number — today's single
-- rate already applies to all of history, and a floored row says exactly that.
--
-- NOT employees.start_date: an hour backdated before someone's start date would
-- resolve to no rate at all and silently drop out of every cost total. History
-- begins when a SECOND row is added, not here.
INSERT INTO "employee_cost_rates" ("org_id", "employee_id", "cost_rate", "effective_from", "created_by_id", "created_at")
SELECT "org_id", "id", "cost_rate", DATE '1970-01-01', "created_by_id", "created_at"
FROM "employees";
