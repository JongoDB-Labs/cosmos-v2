-- Give the work items that were filed as "Milestone" the real milestone rows
-- they were always meant to be.
--
-- A project has ONE real milestone entity: the `milestones` table, which is what
-- the Milestones board, the Release Timeline and the Timeline/Gantt all read.
-- A cross-cutting work-item TYPE also named "Milestone" (`cross.milestone`)
-- shadowed it, so picking "Milestone" in a board's New-issue dialog produced a
-- `work_items` row — never a `milestones` row. It therefore never appeared on
-- any milestone surface, which is exactly what got reported.
--
-- 20260728* / #483 hid the shadow types from the CREATE pickers. That stopped
-- NEW ones being made but left every EXISTING one stranded on a board, still
-- invisible to the Milestones tab. This migration is the other half: it makes
-- the ones already out there real.
--
--
-- DECISION 1 — the originating work item is KEPT, and LINKED. Not deleted.
--
-- A `work_items` row carries things a `milestones` row structurally cannot: a
-- ticket number people cite in conversation, comments, an activity trail,
-- attachments, watchers, assignees, labels, dependency links and a search
-- embedding. Converting-and-deleting would destroy all of it, and a data
-- migration has no business silently throwing away audit history to tidy up a
-- naming collision.
--
-- So the work item stays exactly where it is and `milestone_links` — the model
-- that already exists to associate a milestone with the work that delivers it —
-- carries the association. That gives three things for free:
--
--   * The milestone detail sheet shows "1 linked item" pointing straight back at
--     the original ticket, so the pair is discoverable rather than a mystery
--     duplicate.
--   * `auto_status` (set true below) makes the milestone's status DERIVE from
--     that linked item on every read — see deriveMilestone in src/lib/pm/
--     schedule.ts. Drag the ticket to Done and the milestone reads COMPLETED.
--     The two halves stay in step instead of drifting apart.
--   * It is reversible. Nothing outside `milestones` / `milestone_links` is
--     written, so undoing is a DELETE of the rows this created.
--
-- The cost, stated plainly: the board still shows a "Milestone"-typed card next
-- to a Milestones tab that now also lists it. That duplication is the price of
-- not destroying history, and it is the lesser of the two harms — a visible
-- duplicate is confusing, a deleted comment thread is unrecoverable. Retyping
-- the work item to some other type was rejected as a third option: which type it
-- should become is a guess this migration is not entitled to make, and not every
-- org even has the same types available.
--
-- Note `milestone_links.work_item_id` has no FK to `work_items` (it never has).
-- Deleting the work item later leaves a dangling link, which deriveMilestone
-- already tolerates and skips — the milestone survives its source. That is the
-- desired direction of failure.
--
--
-- DECISION 2 — a work item with NO due date is SKIPPED, and said out loud.
--
-- `milestones.due_date` is NOT NULL. The alternatives were to invent a date
-- (today, or the item's creation date) or to skip. Inventing one is worse than
-- doing nothing: a fabricated date lands on the Release Timeline, the schedule
-- variance report and the PM dashboard as though someone had committed to it.
--
-- Skipping is therefore the choice — but not silently. The DO block below RAISEs
-- a WARNING naming every skipped item. Be aware of where that does and does not
-- show up: `prisma migrate deploy` does NOT relay server messages, so the
-- warning is invisible on the deploy console. It DOES land in the Postgres
-- server log (log_min_messages defaults to WARNING) and prints directly if the
-- file is run through psql. The skipped items are also left completely
-- untouched, still visible on their board where their owner can give them a
-- date. The reliable way to list them afterwards is to ask the database:
--
--   SELECT w.org_id, w.project_id, w.ticket_number, w.title
--   FROM work_items w JOIN work_item_types t ON t.id = w.work_item_type_id
--   WHERE t.key = 'cross.milestone' AND w.due_date IS NULL;
--
-- Re-running this migration once those dates are filled in converts them.
--
--
-- SCOPING — narrow, and a no-op anywhere it does not apply.
--
-- Matched on `work_item_types.key = 'cross.milestone'` and nothing else. Match
-- is by key rather than by a pinned type id because the type is seeded globally
-- (`org_id IS NULL`) but an org or a project template may define its own row
-- with the same key — those shadow the real table just as badly and deserve the
-- same fix. org_id and project_id are always carried from the work item itself,
-- never assumed, so a multi-tenant instance converts each tenant's items into
-- that tenant's own project and cannot leak across orgs.
--
-- Idempotent via `NOT EXISTS (... milestone_links ...)`: a work item that already
-- has a milestone pointing at it is skipped. That covers both re-running this
-- migration (the link it created is the guard) and the case where somebody had
-- already reconciled an item by hand — re-converting either would produce the
-- duplicate milestone this is meant to prevent.
--
-- On an instance with no `cross.milestone` items — a fresh install, or an org
-- that never used the shadow type — every statement here matches zero rows.

-- Say which items are being left behind before doing anything, so the warning is
-- adjacent to the conversion in the deploy log.
DO $$
DECLARE
  undated  RECORD;
  skipped  INT := 0;
BEGIN
  FOR undated IN
    SELECT w."org_id", w."project_id", w."ticket_number", w."title"
    FROM "work_items" w
    JOIN "work_item_types" t ON t."id" = w."work_item_type_id"
    WHERE t."key" = 'cross.milestone'
      AND w."due_date" IS NULL
    ORDER BY w."org_id", w."project_id", w."ticket_number"
  LOOP
    skipped := skipped + 1;
    RAISE WARNING 'milestone conversion SKIPPED (no due date): org=% project=% #% %',
      undated."org_id", undated."project_id", undated."ticket_number", undated."title";
  END LOOP;

  IF skipped > 0 THEN
    RAISE WARNING 'milestone conversion: % work item(s) skipped for a missing due date; they keep their type and stay on their board. Give them a due date and re-run to convert.', skipped;
  END IF;
END
$$;

-- The conversion itself.
--
-- The milestone id is generated up front in the CTE rather than taken from
-- RETURNING, because `milestones` has no column that records which work item it
-- came from — without a pre-computed id there is no way to pair the new row back
-- to its source for the link. MATERIALIZED is explicit so both consumers of the
-- CTE observe the SAME generated ids (gen_random_uuid() is volatile).
WITH convertible AS MATERIALIZED (
    SELECT
        gen_random_uuid()                                        AS milestone_id,
        w."id"                                                   AS work_item_id,
        w."org_id",
        w."project_id",
        w."title",
        -- work_items.description is NOT NULL and defaults to ''; milestones
        -- .description is nullable. Carrying '' across would render an empty
        -- description block instead of none.
        NULLIF(w."description", '')                              AS description,
        w."due_date",
        w."completed_at",
        -- The item's single assignee becomes the milestone's owner. The
        -- many-to-many work_item_assignees are NOT collapsed in — a milestone
        -- has exactly one owner slot and picking one of several assignees would
        -- be arbitrary. They stay on the work item, which keeps them all.
        w."assignee_id"                                          AS owner_id,
        -- Stored status is only a FALLBACK: auto_status is true and a link
        -- exists, so deriveMilestone recomputes it on every read. It still has
        -- to be sane for the day the work item is deleted and the link dangles,
        -- so it mirrors the time-INDEPENDENT half of that same rule (done →
        -- COMPLETED, backlog/todo → UPCOMING, anything else → IN_PROGRESS).
        -- MISSED is deliberately not persisted: it depends on "now", and a
        -- migration-time "now" would be stale the moment it was written.
        CASE
            WHEN w."column_key" = 'done'                            THEN 'COMPLETED'
            WHEN w."column_key" IN ('backlog', 'todo', 'to-do')     THEN 'UPCOMING'
            ELSE 'IN_PROGRESS'
        END::"MilestoneStatus"                                   AS status,
        -- Append after whatever the project already has, so converted milestones
        -- land at the end of the board instead of colliding on 0 with the ones
        -- created through the UI. Ordered by due date for a sensible sequence;
        -- ticket_number breaks ties deterministically.
        COALESCE(
            (SELECT max(m."sort_order") FROM "milestones" m WHERE m."project_id" = w."project_id"),
            -1
        ) + row_number() OVER (PARTITION BY w."project_id" ORDER BY w."due_date", w."ticket_number") AS sort_order,
        -- Keep the work item's creation time: the milestone is the same fact
        -- recorded properly, not something that came into existence today.
        w."created_at"
    FROM "work_items" w
    JOIN "work_item_types" t ON t."id" = w."work_item_type_id"
    WHERE t."key" = 'cross.milestone'
      AND w."due_date" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM "milestone_links" ml WHERE ml."work_item_id" = w."id"
      )
), inserted_milestones AS (
    INSERT INTO "milestones" (
        "id", "org_id", "project_id", "title", "description", "due_date",
        "status", "auto_status", "completed_at", "owner_id", "sort_order",
        "created_at", "updated_at"
    )
    SELECT
        c."milestone_id", c."org_id", c."project_id", c."title", c."description", c."due_date",
        c."status", true, c."completed_at", c."owner_id", c."sort_order",
        c."created_at", CURRENT_TIMESTAMP
    FROM convertible c
    RETURNING "id"
)
INSERT INTO "milestone_links" ("milestone_id", "work_item_id")
SELECT c."milestone_id", c."work_item_id"
FROM convertible c;
