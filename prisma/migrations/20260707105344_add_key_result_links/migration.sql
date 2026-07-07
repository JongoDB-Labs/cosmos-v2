-- OKR → tickets (FR a94ff583): link work items to Key Results + objective target date.

-- AlterTable
ALTER TABLE "objectives" ADD COLUMN     "target_date" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "key_result_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "key_result_id" UUID NOT NULL,
    "work_item_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_result_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_result_links_work_item_id_idx" ON "key_result_links"("work_item_id");

-- CreateIndex
CREATE INDEX "key_result_links_org_id_idx" ON "key_result_links"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "key_result_links_key_result_id_work_item_id_key" ON "key_result_links"("key_result_id", "work_item_id");

-- AddForeignKey
ALTER TABLE "key_result_links" ADD CONSTRAINT "key_result_links_key_result_id_fkey" FOREIGN KEY ("key_result_id") REFERENCES "key_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_result_links" ADD CONSTRAINT "key_result_links_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
