-- Workflow P1: statuses become a project entity, and work-item changes get an
-- outbox.
--
-- A status used to exist only as a board column, per board, so every reader
-- rebuilt "the project's statuses" by unioning columns, and nothing tied an
-- item's column_key to anything: deleting or renaming a column orphaned the
-- items in it. workflow_statuses is the one project-level row per status;
-- work_items(project_id, column_key) now references it (ON UPDATE CASCADE, so a
-- key rename moves every item; ON DELETE RESTRICT, so an occupied status cannot
-- be deleted). Board columns become views onto statuses (status_keys).
--
-- Also: work_items gets the foreign key to projects it never had, so deleting a
-- project removes its items instead of orphaning them.
--
-- The backfill is idempotent (ON CONFLICT DO NOTHING throughout): running it
-- again changes nothing.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE "workflow_statuses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "category" "ColumnCategory" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_statuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_statuses_project_id_key_key" ON "workflow_statuses"("project_id", "key");
CREATE INDEX "workflow_statuses_org_id_project_id_idx" ON "workflow_statuses"("org_id", "project_id");

ALTER TABLE "workflow_statuses" ADD CONSTRAINT "workflow_statuses_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_statuses" ADD CONSTRAINT "workflow_statuses_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor_id" UUID,
    "source" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "depth" INTEGER NOT NULL DEFAULT 0,
    "caused_by_rule_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "domain_events_org_id_created_at_idx" ON "domain_events"("org_id", "created_at");
CREATE INDEX "domain_events_subject_id_created_at_idx" ON "domain_events"("subject_id", "created_at");
-- The consumer's claim query: the oldest unprocessed events.
CREATE INDEX "domain_events_unprocessed_idx" ON "domain_events"("id") WHERE "processed_at" IS NULL;

ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "board_columns" ADD COLUMN "status_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ── Backfill: one status per key a project's status boards show ─────────────
--
-- Ceremony boards (SPRINT_PLANNING, SPRINT_REVIEW) are skipped: their columns
-- are retro prompts (Start / Stop / Continue), not statuses.
--
-- One key on several boards becomes one status. Its name, colour, order AND
-- category come from the first column by (board order, board age, column
-- order): the rule the status pickers already use for the name, and the one the
-- server has used for the category since the single writer (loadStatusCategories),
-- so nothing an item does changes. Keys whose boards disagree on the category
-- are recorded in the audit log below for an admin to review.

WITH status_columns AS (
    SELECT b.org_id, b.project_id, bc.key, bc.name, bc.color, bc.category,
           b.sort_order AS board_order, b.created_at AS board_created, bc.sort_order AS column_order,
           row_number() OVER (
               PARTITION BY b.project_id, bc.key
               ORDER BY b.sort_order, b.created_at, bc.sort_order, bc.id
           ) AS rn
    FROM board_columns bc
    JOIN boards b ON b.id = bc.board_id
    JOIN projects p ON p.id = b.project_id
    WHERE b.type NOT IN ('SPRINT_PLANNING', 'SPRINT_REVIEW')
)
-- Statuses take the order their first columns appear in, numbered 0, 1, 2… per
-- project, so two boards' "2"s do not tie.
INSERT INTO workflow_statuses (org_id, project_id, key, name, color, category, sort_order)
SELECT org_id, project_id, key, name, color, category,
       (row_number() OVER (PARTITION BY project_id ORDER BY board_order, board_created, column_order, key) - 1)::int
FROM status_columns
WHERE rn = 1
ON CONFLICT (project_id, key) DO NOTHING;

-- Keys items hold that no status board shows (a deleted or renamed column, or a
-- key only a ceremony board has): an ARCHIVED status, so the item keeps its
-- status and the foreign key can hold. Archived statuses are hidden from
-- pickers and listed for an admin to map or restore; a board column that names
-- one later restores it (ensureStatuses).
--
-- Its category comes from the key's spelling only, the same words
-- isDoneStatus falls back on (src/lib/work-items/done-state.ts): never from
-- the items. completed_at is an Actual End people set by hand, so "any item
-- has one" would mark a Timeline project's open "todo" as DONE and count all
-- its work as finished.
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

-- ── The record for admins (AU-2): what the backfill could not decide alone ──
-- audit_logs' hash chain is filled by its insert trigger, so these rows chain
-- like any other.

-- A key whose status boards disagree on its category.
INSERT INTO audit_logs (org_id, action, entity, entity_id, metadata)
SELECT s.org_id, 'workflow.backfill_conflict', 'workflow_status', s.id::text,
       jsonb_build_object(
           'projectId', s.project_id::text,
           'key', s.key,
           'chosenCategory', s.category::text,
           'categories', (
               SELECT jsonb_agg(DISTINCT bc.category::text)
               FROM board_columns bc JOIN boards b ON b.id = bc.board_id
               WHERE b.project_id = s.project_id AND bc.key = s.key
                 AND b.type NOT IN ('SPRINT_PLANNING', 'SPRINT_REVIEW')
           )
       )
FROM workflow_statuses s
WHERE (
    SELECT count(DISTINCT bc.category)
    FROM board_columns bc JOIN boards b ON b.id = bc.board_id
    WHERE b.project_id = s.project_id AND bc.key = s.key
      AND b.type NOT IN ('SPRINT_PLANNING', 'SPRINT_REVIEW')
) > 1
AND NOT EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.action = 'workflow.backfill_conflict' AND a.entity_id = s.id::text
);

-- A key items hold that no board showed: created archived, above.
INSERT INTO audit_logs (org_id, action, entity, entity_id, metadata)
SELECT s.org_id, 'workflow.backfill_orphan_status', 'workflow_status', s.id::text,
       jsonb_build_object(
           'projectId', s.project_id::text,
           'key', s.key,
           'category', s.category::text,
           'items', (SELECT count(*) FROM work_items w WHERE w.project_id = s.project_id AND w.column_key = s.key)::text
       )
FROM workflow_statuses s
WHERE s.archived_at IS NOT NULL
AND NOT EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.action = 'workflow.backfill_orphan_status' AND a.entity_id = s.id::text
);

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- Added NOT VALID: enforced at once for every new or changed row, and the
-- existing rows are checked separately. Prisma runs this whole file as one
-- transaction, so the ADDs' locks are held until it commits either way; what
-- NOT VALID buys here is that a violating legacy row does not fail the
-- migration. Each constraint is then VALIDATEd only when no existing row
-- violates it. The one row that can: an item whose project was deleted
-- before work_items had this foreign key (it cannot get a status either, its
-- project being gone). Those are left as they are, counted per org in the audit
-- log, and the constraint stays unvalidated until they are dealt with; deleting
-- them is a separate, explicit decision.

CREATE INDEX "work_items_project_id_column_key_idx" ON "work_items"("project_id", "column_key");

ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_column_key_fkey"
    FOREIGN KEY ("project_id", "column_key") REFERENCES "workflow_statuses"("project_id", "key")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

INSERT INTO audit_logs (org_id, action, entity, metadata)
SELECT w.org_id, 'workflow.backfill_orphan_items', 'work_item',
       jsonb_build_object('items', count(*)::text, 'projects', count(DISTINCT w.project_id)::text)
FROM work_items w
WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id)
GROUP BY w.org_id
HAVING NOT EXISTS (
    SELECT 1 FROM audit_logs a WHERE a.action = 'workflow.backfill_orphan_items' AND a.org_id = w.org_id
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id)
    ) THEN
        ALTER TABLE "work_items" VALIDATE CONSTRAINT "work_items_project_id_fkey";
        ALTER TABLE "work_items" VALIDATE CONSTRAINT "work_items_project_id_column_key_fkey";
    ELSE
        RAISE NOTICE 'work_items holds items of deleted projects: foreign keys left NOT VALID (see audit_logs workflow.backfill_orphan_items)';
    END IF;
END $$;
