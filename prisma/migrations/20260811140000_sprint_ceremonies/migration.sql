-- Sprint ceremonies: the persistent half of the sprint planning and
-- review/retro boards.
--
-- Only the parts a team TYPES live here. Everything a ceremony reports —
-- points, item counts, what shipped, what carried, the next sprint's window —
-- derives from work items and intervals on read, so a ceremony reopened a year
-- later still reconciles with the board it describes. Storing a second copy of
-- those figures is how a report and its board come to disagree.
--
-- Additive only: three new tables and two new enums. No existing column changes.

CREATE TYPE "ceremony_kind" AS ENUM ('PLANNING', 'REVIEW');

-- CLOSED is a real event rather than a view: it is what distinguishes "we held
-- this retro" from "nobody ever opened the board".
CREATE TYPE "ceremony_status" AS ENUM ('DRAFT', 'RUNNING', 'CLOSED');

-- One running of one ceremony board against one sprint. The board is a reusable
-- surface; this row is the occurrence, which is why the same board can run every
-- sprint without duplicating.
CREATE TABLE "sprint_ceremonies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "interval_id" UUID NOT NULL,
    "kind" "ceremony_kind" NOT NULL,
    "status" "ceremony_status" NOT NULL DEFAULT 'DRAFT',
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sprint_ceremonies_pkey" PRIMARY KEY ("id")
);

-- A sticky note in one retro column. `column_key` points at a board_columns row
-- exactly as work_items.column_key does, so Start/Stop/Continue is an ordinary,
-- editable column set — colour included — rather than a hardcoded trio.
CREATE TABLE "retro_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ceremony_id" UUID NOT NULL,
    "column_key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "author_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retro_notes_pkey" PRIMARY KEY ("id")
);

-- An action agreed in the ceremony. `work_item_id` is set when someone promotes
-- it into tracked work; nullable because an action is typed mid-conversation.
CREATE TABLE "retro_action_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ceremony_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "owner_id" UUID,
    "due_date" TIMESTAMP(3),
    "work_item_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retro_action_items_pkey" PRIMARY KEY ("id")
);

-- Re-opening the board for sprint 15 is a NEW row, never a second retro against
-- sprint 14.
CREATE UNIQUE INDEX "sprint_ceremonies_board_id_interval_id_key"
    ON "sprint_ceremonies"("board_id", "interval_id");
CREATE INDEX "sprint_ceremonies_interval_id_idx"
    ON "sprint_ceremonies"("interval_id");
-- Notes are always read a column at a time.
CREATE INDEX "retro_notes_ceremony_id_column_key_idx"
    ON "retro_notes"("ceremony_id", "column_key");
CREATE INDEX "retro_action_items_ceremony_id_idx"
    ON "retro_action_items"("ceremony_id");

-- Deleting the board or the sprint removes the ceremony; deleting the ceremony
-- removes what was said in it.
ALTER TABLE "sprint_ceremonies" ADD CONSTRAINT "sprint_ceremonies_board_id_fkey"
    FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sprint_ceremonies" ADD CONSTRAINT "sprint_ceremonies_interval_id_fkey"
    FOREIGN KEY ("interval_id") REFERENCES "intervals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retro_notes" ADD CONSTRAINT "retro_notes_ceremony_id_fkey"
    FOREIGN KEY ("ceremony_id") REFERENCES "sprint_ceremonies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retro_action_items" ADD CONSTRAINT "retro_action_items_ceremony_id_fkey"
    FOREIGN KEY ("ceremony_id") REFERENCES "sprint_ceremonies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade, on all three of these. Losing a person must not delete
-- what the team said, and deleting a promoted work item must not erase the
-- record that the team agreed to do it.
ALTER TABLE "retro_notes" ADD CONSTRAINT "retro_notes_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "retro_action_items" ADD CONSTRAINT "retro_action_items_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "retro_action_items" ADD CONSTRAINT "retro_action_items_work_item_id_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
