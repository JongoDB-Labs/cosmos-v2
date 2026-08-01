-- The org chart becomes a GRAPH: an employee may have several supervisors.
--
-- `employees.manager_id` could hold exactly one, which does not match how work
-- is actually supervised — a matrixed org, a deputy covering leave, a worker
-- split across two programmes. It is superseded here, backfilled below, and left
-- in place (unread) for one release so a rollback to the previous image still
-- finds its column.
--
-- Cascade on BOTH sides is deliberate. Deleting an employee must not leave rows
-- pointing at a ghost, and a departing supervisor should leave their reports
-- visibly UNSUPERVISED — which the timesheet now surfaces — rather than
-- silently supervised by a record that no longer exists.
CREATE TABLE "employee_supervisors" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"        UUID NOT NULL,
  "employee_id"   UUID NOT NULL,
  "supervisor_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "employee_supervisors_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "employee_supervisors"
  ADD CONSTRAINT "employee_supervisors_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "employee_supervisors"
  ADD CONSTRAINT "employee_supervisors_supervisor_id_fkey"
  FOREIGN KEY ("supervisor_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Assigning the same supervisor twice is a no-op, not a duplicate.
CREATE UNIQUE INDEX "employee_supervisors_employee_id_supervisor_id_key"
  ON "employee_supervisors"("employee_id", "supervisor_id");

-- "Whose time may I see / approve" — the hot path on every scoped time read.
CREATE INDEX "employee_supervisors_org_id_supervisor_id_idx"
  ON "employee_supervisors"("org_id", "supervisor_id");
CREATE INDEX "employee_supervisors_org_id_employee_id_idx"
  ON "employee_supervisors"("org_id", "employee_id");

-- Backfill the existing single-supervisor chart.
--
-- `created_by_id` is the employee's own creator, which is the closest thing to
-- the truth we have: nobody performed this assignment today, and inventing an
-- actor would put a false name in an audit trail. The self-referential guard
-- matters — a record naming ITSELF as its manager names no supervisor at all,
-- and carrying that forward would make the person's timesheet unapprovable
-- (barred from self-approval, with nobody else designated). The cross-tenant
-- guard matters for the same reason `managerUserIdOf` has one: manager_id is a
-- bare FK with no org constraint, so a pointer into another org is
-- representable and must not become a supervisor here.
INSERT INTO "employee_supervisors" ("org_id", "employee_id", "supervisor_id", "created_by_id")
SELECT e."org_id", e."id", e."manager_id", e."created_by_id"
  FROM "employees" e
  JOIN "employees" m ON m."id" = e."manager_id" AND m."org_id" = e."org_id"
 WHERE e."manager_id" IS NOT NULL
   AND e."manager_id" <> e."id"
ON CONFLICT ("employee_id", "supervisor_id") DO NOTHING;
