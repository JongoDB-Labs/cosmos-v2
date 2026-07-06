-- Watchers (FR 8702c9b8): a user follows a work item ("watched tickets").

-- CreateTable
CREATE TABLE "work_item_watchers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_watchers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_watchers_work_item_id_user_id_key" ON "work_item_watchers"("work_item_id", "user_id");

-- CreateIndex
CREATE INDEX "work_item_watchers_org_id_user_id_idx" ON "work_item_watchers"("org_id", "user_id");

-- AddForeignKey
ALTER TABLE "work_item_watchers" ADD CONSTRAINT "work_item_watchers_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_watchers" ADD CONSTRAINT "work_item_watchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
