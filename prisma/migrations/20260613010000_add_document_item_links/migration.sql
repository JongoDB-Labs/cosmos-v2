-- Document → project-item links (convert a block into an issue/milestone/… and
-- link it back). ADDITIVE: new enum + table. Hard FK on block (cascade); item is
-- a soft reference. Hand-authored. cosmos_app reaches the new table via DB-init
-- default privileges (no GRANT; like roadmap_nodes / document_blocks).

CREATE TYPE "LinkedItemType" AS ENUM ('WORK_ITEM','MILESTONE','OBJECTIVE','GOAL','CYCLE','ROADMAP_NODE');

CREATE TABLE "document_item_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "block_id" UUID NOT NULL,
  "item_type" "LinkedItemType" NOT NULL,
  "item_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_item_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_item_links_org_id_project_id_item_type_item_id_idx" ON "document_item_links"("org_id","project_id","item_type","item_id");
CREATE INDEX "document_item_links_block_id_idx" ON "document_item_links"("block_id");
ALTER TABLE "document_item_links" ADD CONSTRAINT "document_item_links_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "document_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
