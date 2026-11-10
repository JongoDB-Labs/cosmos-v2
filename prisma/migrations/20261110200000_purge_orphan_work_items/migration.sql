-- Remove work items whose project no longer exists, then validate the two
-- work_items foreign keys that 20261023230000_workflow_statuses had to leave
-- NOT VALID because of them.
--
-- That migration left these rows alone on purpose ("deleting them is a
-- separate, explicit decision"). The decision is now made: an item of a
-- deleted project is reachable from no page, no board and no API route, since
-- every one of them goes through the project.
--
-- What goes with an item (its foreign keys, ON DELETE CASCADE): its activity,
-- comments, assignees, watchers, labels, links, and OKR objective / key-result
-- links; and with each comment, its reactions, revisions and feedback
-- attachment rows. What stays and loses the reference (ON DELETE SET NULL): a
-- document, retro action item, child item or merged item that pointed at it, a
-- reply to one of its comments, and a feedback item whose official comment it
-- held. A few tables hold a work-item id with no foreign key at all (time
-- entries, goal / milestone / document links, deliverables' work_item_ref,
-- flags, external event links, domain events, planning cards, feedback,
-- Foreman's records); those are left as they are, as they already pointed at
-- an item nothing could reach.
--
-- ONE statement, on purpose. `prisma migrate deploy` splits a migration into
-- statements and sends each on its own, outside a transaction (see
-- 20261024070000_cql_indexes), so a file of several statements commits several
-- times: a VALIDATE that failed would leave the delete, and the audit row
-- saying it happened, already committed, with only the backup to undo them. A
-- single DO block is one statement, so it applies whole or not at all however
-- Prisma submits it. purge-orphan-work-items.migration.test.ts pins the shape.
DO $$
BEGIN
    -- 1. Which items go. Noted once, so the delete and the audit row below
    -- name exactly the same rows.
    CREATE TEMP TABLE purge_orphan_work_items ON COMMIT DROP AS
    SELECT w.id, w.org_id, w.project_id, w.created_at
    FROM work_items w
    WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id);

    -- 2. A live item whose status key has no status gets an ARCHIVED one, by
    -- the same rule 20261023230000 used (category from the key's spelling
    -- only). That migration covered every key in use when it ran, but an item
    -- written between its backfill and its index, or imported with triggers
    -- off (scripts/cutover), could still lack one, and the second VALIDATE
    -- below would fail on it. A no-op where nothing is missing.
    INSERT INTO workflow_statuses (org_id, project_id, key, name, category, sort_order, archived_at)
    SELECT p.org_id, w.project_id, w.column_key, w.column_key,
           CASE
               WHEN lower(w.column_key) LIKE '%cancel%' THEN 'CANCELLED'::"ColumnCategory"
               WHEN lower(w.column_key) ~ '(done|completed|closed|finished)' THEN 'DONE'::"ColumnCategory"
               ELSE 'TODO'::"ColumnCategory"
           END,
           1000,
           CURRENT_TIMESTAMP
    FROM work_items w
    JOIN projects p ON p.id = w.project_id
    WHERE NOT EXISTS (
        SELECT 1 FROM workflow_statuses s WHERE s.project_id = w.project_id AND s.key = w.column_key
    )
    GROUP BY p.org_id, w.project_id, w.column_key
    ON CONFLICT (project_id, key) DO NOTHING;

    -- 3. The orphans, and what cascades from them.
    DELETE FROM work_items w USING purge_orphan_work_items o WHERE w.id = o.id;

    -- 4. Unconditional, unlike the guarded block in 20261023230000: with the
    -- orphans gone and every live key given a status, neither constraint has a
    -- row left that can violate it. If one still fails, the whole statement
    -- fails and nothing above is kept.
    ALTER TABLE "work_items" VALIDATE CONSTRAINT "work_items_project_id_fkey";
    ALTER TABLE "work_items" VALIDATE CONSTRAINT "work_items_project_id_column_key_fkey";

    -- 5. What went, per org, by item and project id, so the pre-deploy backup
    -- can be searched for it. LAST on purpose: the audit_logs trigger takes the
    -- hash-chain lock every audited write in the app waits on, and holds it to
    -- commit, so taking it here holds it for the commit alone rather than
    -- across the delete and both validations.
    INSERT INTO audit_logs (org_id, action, entity, metadata)
    SELECT o.org_id, 'work_item.purge_orphans', 'work_item',
           jsonb_build_object(
               'items', count(*)::text,
               'projects', count(DISTINCT o.project_id)::text,
               'projectIds', jsonb_agg(DISTINCT o.project_id),
               'itemIds', jsonb_agg(o.id ORDER BY o.created_at)
           )
    FROM purge_orphan_work_items o
    GROUP BY o.org_id;
END $$;
