-- Multi-assignee (FR 1d38496a): full assignee set per work item, including the
-- primary. work_items.assignee_id remains the primary/owner.

-- CreateTable
CREATE TABLE "work_item_assignees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_assignees_work_item_id_user_id_key" ON "work_item_assignees"("work_item_id", "user_id");

-- CreateIndex
CREATE INDEX "work_item_assignees_user_id_idx" ON "work_item_assignees"("user_id");

-- AddForeignKey
ALTER TABLE "work_item_assignees" ADD CONSTRAINT "work_item_assignees_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_assignees" ADD CONSTRAINT "work_item_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing single assignee becomes that item's (primary)
-- assignee row. work_items.assignee_id has NO users FK, so the join guards
-- against dangling ids that would violate the new constraint.
INSERT INTO "work_item_assignees" ("work_item_id", "user_id")
SELECT w."id", w."assignee_id"
FROM "work_items" w
JOIN "users" u ON u."id" = w."assignee_id"
WHERE w."assignee_id" IS NOT NULL
ON CONFLICT ("work_item_id", "user_id") DO NOTHING;
