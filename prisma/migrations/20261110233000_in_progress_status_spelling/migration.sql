-- One spelling for the in-progress status key, `in-progress`, where that can
-- be done without breaking anything that names the old one.
--
-- What this merges: the 20261023230000 backfill turned item keys that no status
-- had into ARCHIVED statuses, so a project can hold an archived `in_progress`
-- beside its live `in-progress`. Archived statuses get no board column, and a
-- board shows an item only in the column whose key is the item's status, so
-- those items appear on no board. Their items move to the live `in-progress`
-- status and the archived row is deleted. The live row is untouched.
--
-- What this leaves alone:
--   * A LIVE `in_progress` status, with or without an `in-progress` beside it.
--     Boards show it through a column whose `key` is `in_progress`, and
--     workflow definitions, automation rules and saved CQL name it as text;
--     renaming it here would empty that column and silently break the rest.
--   * Every project in an org where anything other than a status or an item
--     names `in_progress`: a board column, a board's config, an automation
--     rule, a saved view, a workflow version or a workflow assignment. The
--     whole org is skipped rather than reasoning about which reference matters.
-- What was left is visible as it was: the rows themselves are the record.
--
-- History keeps the key that was true when written: activities.old_value, and
-- audit_logs (hash-chained; never edited).
--
-- ONE statement, because `prisma migrate deploy` sends each statement of a file
-- on its own, outside a transaction (see 20261110200000_purge_orphan_work_items).
-- The audit rows go last: the audit hash-chain trigger takes an advisory lock
-- and a row lock on audit_chain_head, which should be held as briefly as possible.
DO $$
DECLARE
    -- `in_progress` as a whole token: not `in_progress_qa`, not `do_in_progress`.
    token CONSTANT text := '(^|[^A-Za-z0-9_-])in_progress([^A-Za-z0-9_-]|$)';
BEGIN
    -- Hold every status this decides on until it commits. The app keeps
    -- serving during a deploy: a duplicate restored after the decision would be
    -- deleted while live, and an `in-progress` archived after it would receive
    -- items while archived.
    PERFORM 1 FROM workflow_statuses
     WHERE key IN ('in_progress', 'in-progress')
       AND project_id IN (SELECT project_id FROM workflow_statuses WHERE key = 'in_progress')
       FOR UPDATE;
    CREATE TEMP TABLE spelling_named ON COMMIT DROP AS
    SELECT DISTINCT org_id FROM (
        SELECT b.org_id FROM board_columns c JOIN boards b ON b.id = c.board_id
         WHERE c.key = 'in_progress' OR 'in_progress' = ANY (c.status_keys)
        UNION ALL SELECT org_id FROM boards WHERE config::text ~ token
        UNION ALL SELECT org_id FROM automation_rules WHERE spec::text ~ token
        UNION ALL SELECT org_id FROM saved_views
         WHERE concat_ws(' ', cql_text, query::text, filter::text) ~ token
        UNION ALL SELECT org_id FROM workflow_versions
         WHERE concat_ws(' ', definition::text, migration_map::text) ~ token
        UNION ALL SELECT org_id FROM workflow_assignments WHERE migration_map::text ~ token
    ) named;

    CREATE TEMP TABLE spelling_statuses ON COMMIT DROP AS
    SELECT s.id, s.org_id, s.project_id,
           s.archived_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM workflow_statuses n
                        WHERE n.project_id = s.project_id AND n.key = 'in-progress' AND n.archived_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM spelling_named x WHERE x.org_id = s.org_id) AS merge
    FROM workflow_statuses s
    WHERE s.key = 'in_progress';

    CREATE TEMP TABLE spelling_items ON COMMIT DROP AS
    SELECT w.id, w.org_id, w.created_at
    FROM work_items w
    JOIN spelling_statuses x ON x.project_id = w.project_id AND x.merge
    WHERE w.column_key = 'in_progress';

    UPDATE work_items w SET column_key = 'in-progress'
    FROM spelling_items i WHERE w.id = i.id;

    DELETE FROM workflow_statuses s
    USING spelling_statuses x WHERE s.id = x.id AND x.merge;

    INSERT INTO audit_logs (org_id, action, entity, metadata)
    SELECT x.org_id, 'workflow_status.normalize_in_progress', 'workflow_status',
           jsonb_build_object(
               'merged', count(*)::text,
               'items', (SELECT count(*) FROM spelling_items i WHERE i.org_id = x.org_id)::text,
               'projectIds', jsonb_agg(x.project_id ORDER BY x.project_id),
               'itemIds', COALESCE((SELECT jsonb_agg(i.id ORDER BY i.created_at)
                                     FROM spelling_items i WHERE i.org_id = x.org_id), '[]'::jsonb))
    FROM spelling_statuses x
    WHERE x.merge
    GROUP BY x.org_id;
END $$;
