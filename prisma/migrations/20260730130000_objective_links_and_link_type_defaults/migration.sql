-- #52 — map high-level delivery to objectives, and let a project choose which
-- work-item type its link pickers offer first.
--
-- Purely additive. No existing row is read, rewritten or deleted:
--   * `key_result_links` is UNTOUCHED. Those rows point at Stories, they are
--     live, and an auto-tracking KR derives currentValue from how many of them
--     are done — repurposing them would silently move progress numbers people
--     already read. Existing links stay valid; only which type a picker offers
--     FIRST changes.
--   * `objectives.parent_objective_id` is untouched: objective→objective
--     laddering keeps working exactly as before and is still the default.
--
-- Both new columns are NULLABLE with no default, so every existing project
-- reads as "not configured" and falls back to resolving a type named "Feature".

-- Objective → work item. Shaped like key_result_links; no type column, because
-- the work item already knows its type.
CREATE TABLE "objective_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "objective_links_pkey" PRIMARY KEY ("id")
);

-- One link per (objective, work item); re-linking is idempotent, not duplicated.
CREATE UNIQUE INDEX "objective_links_objective_id_work_item_id_key"
    ON "objective_links"("objective_id", "work_item_id");
CREATE INDEX "objective_links_work_item_id_idx" ON "objective_links"("work_item_id");
CREATE INDEX "objective_links_org_id_idx" ON "objective_links"("org_id");

-- Both ends CASCADE: deleting an objective or a work item removes the link
-- rather than orphaning it. Matches key_result_links.
ALTER TABLE "objective_links"
    ADD CONSTRAINT "objective_links_objective_id_fkey"
    FOREIGN KEY ("objective_id") REFERENCES "objectives"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "objective_links"
    ADD CONSTRAINT "objective_links_work_item_id_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The configurable defaults. No FK to work_item_types: a type can be retired
-- while projects still reference it, and a dangling id must degrade to the
-- "Feature" fallback rather than block the delete or wipe the setting.
ALTER TABLE "projects" ADD COLUMN "kr_link_type_id" UUID;
ALTER TABLE "projects" ADD COLUMN "objective_link_type_id" UUID;
