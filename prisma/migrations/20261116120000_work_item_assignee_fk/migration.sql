-- work_items.assignee_id, the primary assignee, now references users(id).
--
-- Why: the query language reads `team = X` as "tagged with X, or untagged and
-- assigned to someone on X". With a relation from the item to its assignee
-- that is a join in the database. Without one, the server had to ship every
-- team member's user id inside the compiled query: past 30,000 members the
-- query was refused as too broad, and the ids reached the browser of anyone
-- who could filter by team, a guest included.
--
-- NOT VALID: every row written or changed from now on is checked, and the rows
-- already there are not. Some databases hold items whose assignee is not a
-- user (Duplicate copied whatever the source named, and two repro seeds wrote
-- membership ids), and validating would fail the deploy over them. They read
-- as assigned to no team's member, which is what they were. Validating later
-- is a separate step.
--
-- ON DELETE SET NULL: deleting a user leaves their items unassigned, as
-- deleting a team does for team_id. ON UPDATE CASCADE is Prisma's default for
-- a relation, so the schema and this file agree.
--
-- Cutover: scripts/cutover/import-org.mjs loads rows with
-- session_replication_role = replica, which skips foreign-key checks, so this
-- key does not refuse an imported item whose assignee did not come across. The
-- cutover verify probes it as a catalog foreign key instead, now that
-- BARE_USER_REF_COLUMNS no longer lists it (scripts/cutover/lib/model-graph.ts).
--
-- One DO block, so it applies whole however Prisma submits it, and the guard
-- lets an interrupted deploy run again.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'work_items_assignee_id_fkey' AND conrelid = 'work_items'::regclass
    ) THEN
        ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_fkey"
            FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
    END IF;
END $$;
