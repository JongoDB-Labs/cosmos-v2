-- A worker asking to be given a supervisor.
--
-- Submitting a timesheet is now refused when nobody supervises you, so this is
-- the route out of that block. It is a REQUEST, not self-service: the worker
-- names who they want and the permission-holder performs the assignment.
-- Letting the subject assign their own approver would defeat the control the
-- approval workflow exists to provide.
--
-- A ROW IS AN OPEN REQUEST — there is no status column. Honouring or declining
-- one deletes it, which makes the unique index below the spam guard by
-- construction (one open request per pair) with no partial index to maintain.
-- The permanent record of who asked for what is the audit log.
--
-- Cascade on both sides for the same reason as employee_supervisors: neither a
-- departing worker nor a departing approver should leave rows pointing at a
-- record that no longer exists.
CREATE TABLE "supervisor_requests" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"          UUID NOT NULL,
  "employee_id"     UUID NOT NULL,
  "supervisor_id"   UUID NOT NULL,
  "requested_by_id" UUID NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "supervisor_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "supervisor_requests"
  ADD CONSTRAINT "supervisor_requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supervisor_requests"
  ADD CONSTRAINT "supervisor_requests_supervisor_id_fkey"
  FOREIGN KEY ("supervisor_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The spam guard: asking the same person twice is a no-op, not a second ping.
CREATE UNIQUE INDEX "supervisor_requests_employee_id_supervisor_id_key"
  ON "supervisor_requests"("employee_id", "supervisor_id");

-- "Who has asked ME to supervise them" — what the approver's queue reads.
CREATE INDEX "supervisor_requests_org_id_supervisor_id_idx"
  ON "supervisor_requests"("org_id", "supervisor_id");
