-- Record who a submitted timesheet was routed TO.
--
-- Before this, submitting flipped a status and told nobody: there was no answer
-- to "who am I submitting this week to?", and hours sat in SUBMITTED until an
-- admin happened to look.
--
-- An ARRAY rather than a single approver, because both real cases are plural: a
-- worker may have several supervisors, and a worker with none falls to the whole
-- pool of people who may approve time. A scalar column would record one of them
-- and silently discard the rest, which is the opposite of an audit trail.
--
-- Deliberately NOT backfilled. Rows submitted before routing existed were routed
-- to nobody, and inventing an approver for them would fabricate an audit record —
-- the one thing this table exists to prevent. The empty array reads as "nobody
-- was asked", which is precisely what happened to them.
--
-- No foreign key, matching `labor_approved_by_id` / `cost_approved_by_id` on this
-- table: an approver later removed from the org must leave the historical record
-- intact, not cascade it away or block their deletion. (A UUID[] cannot carry one
-- in Postgres anyway, which makes the existing convention the only option here.)
ALTER TABLE "timesheets"
  ADD COLUMN "approver_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Serves the approvals queue: "sheets routed to me, still awaiting a signature".
-- GIN, because the query is containment (`approver_ids @> ARRAY[me]`), which a
-- B-tree cannot answer.
CREATE INDEX "timesheets_approver_ids_idx" ON "timesheets" USING GIN ("approver_ids");
