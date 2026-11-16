-- work_items.assignee_id, the primary assignee, now references users(id).
--
-- Why: the query language reads `team = X` as "tagged with X, or untagged and
-- assigned to someone on X". With a relation from the item to its assignee
-- that is a join in the database. Without one, the server had to ship every
-- team member's user id inside the compiled query: past 30,000 members the
-- query was refused as too broad, and the ids reached the browser.
--
-- Some databases hold items whose assignee is not a user (Duplicate copied
-- whatever the source named, and two repro seeds wrote membership ids). NOT
-- VALID alone would not make those rows safe: Postgres skips the check on an
-- unchanged key only for a row not already written in the same transaction,
-- so an edit that writes the row twice (labels, then the other fields; a
-- merge that moves labels) is checked, and failed. So, in one statement:
--
--   1. The key, NOT VALID, so adding it doesn't scan the table. Every write
--      from here on is checked.
--   2. Those assignees are cleared: the item becomes unassigned, which is what
--      it was to every reader (no user, so no one's work, no team's). Their
--      co-assignee rows (work_item_assignees) already reference users, so
--      they hold none of these.
--   3. What was cleared is recorded, per org, by item id and the value it
--      held, so the pre-deploy backup can be searched for it.
--
-- 20261116120100 then validates the key, so it ends fully trusted.
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
-- ONE statement, on purpose. `prisma migrate deploy` sends a file of several
-- statements one at a time, each committed on its own (see
-- 20261110200000_purge_orphan_work_items), so the clear and the audit row
-- could commit apart. A single DO block applies whole or not at all, and its
-- guard and its "names no user" test let an interrupted deploy run it again.
-- work-item-assignee-fk.migration.test.ts pins the shape.
DO $$
BEGIN
    -- 1. The key.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'work_items_assignee_id_fkey' AND conrelid = 'work_items'::regclass
    ) THEN
        ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_fkey"
            FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
    END IF;

    -- Writes to work_items wait until this commits, so the rows noted below are
    -- exactly the rows cleared. Adding the key takes this lock already; it is
    -- taken here too for a re-run, where the key exists and isn't added.
    LOCK TABLE "work_items" IN SHARE ROW EXCLUSIVE MODE;

    -- 2. The items whose assignee is no user, noted once so the clear and the
    -- audit row name exactly the same rows; then cleared.
    CREATE TEMP TABLE clear_dangling_assignees ON COMMIT DROP AS
    SELECT w.id, w.org_id, w.assignee_id, w.created_at
    FROM work_items w
    WHERE w.assignee_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.assignee_id);

    UPDATE "work_items" w SET assignee_id = NULL
    FROM clear_dangling_assignees c
    WHERE w.id = c.id;

    -- 3. What was cleared, per org. LAST on purpose: the audit_logs trigger
    -- takes the hash-chain lock every audited write in the app waits on, and
    -- holds it to commit, so taking it here holds it for the commit alone.
    INSERT INTO audit_logs (org_id, action, entity, metadata)
    SELECT c.org_id, 'work_item.clear_dangling_assignees', 'work_item',
           jsonb_build_object(
               'items', count(*)::text,
               'itemIds', jsonb_agg(c.id ORDER BY c.created_at),
               'assigneeIds', jsonb_agg(DISTINCT c.assignee_id)
           )
    FROM clear_dangling_assignees c
    GROUP BY c.org_id;
END $$;
