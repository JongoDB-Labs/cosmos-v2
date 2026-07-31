-- The org chart: who supervises whom.
--
-- Time entries were readable org-wide by anyone holding TIME_READ (fixed in
-- 2.249.21, which pinned reads to the actor). That fix left supervisors unable
-- to see the time they are responsible for approving, because there was no
-- record anywhere of who supervises whom — `Employee` had no manager column.
--
-- Deliberately on `Employee` rather than a new supervisory-assignment table:
-- the employee record already exists, already carries cost rate and labor
-- category, and is already managed under Finance -> Payroll behind
-- FINANCE_MANAGE. A second table would be a second answer to "who is this
-- person's manager".
--
-- NULLABLE with no backfill: every existing employee starts with no manager and
-- therefore no change in who can read their time. The feature is opt-in per
-- employee, so this migration cannot widen anyone's access on its own.
--
-- ON DELETE SET NULL, not CASCADE: deleting a manager must orphan their reports
-- (visible in the UI as a blank supervisor, and fixable) rather than delete the
-- reports themselves. Cascade here would silently destroy employee records —
-- and with them cost rates that pay runs depend on.
ALTER TABLE "employees" ADD COLUMN "manager_id" UUID;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "employees"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Every scoped time read asks "which employees report to me", so that lookup is
-- indexed rather than a sequential scan of the org's employees.
CREATE INDEX "employees_org_id_manager_id_idx" ON "employees"("org_id", "manager_id");
