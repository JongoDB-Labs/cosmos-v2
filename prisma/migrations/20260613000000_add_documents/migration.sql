-- Files ingestion. ADDITIVE — the `documents` table already exists (a CUI-aware
-- document-management table: title/classification_level/storage_key/filename/
-- content_type/size/uploaded_by_id, with demo rows). We EXTEND it with parse
-- status + a normalized block tree; existing rows keep their data (new columns
-- default/nullable). Hand-authored (NOT prisma migrate diff). cosmos_app reaches
-- the new column/table via DB-init default privileges (no GRANT; like roadmap_nodes).

CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED','PARSING','READY','FAILED');
CREATE TYPE "DocumentBlockKind" AS ENUM ('HEADING','PARAGRAPH','LIST','TABLE','CODE','IMAGE','QUOTE','PAGE_BREAK');

-- Extend the existing documents table (additive; existing rows -> status UPLOADED).
ALTER TABLE "documents"
  ADD COLUMN "format" TEXT,
  ADD COLUMN "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
  ADD COLUMN "parse_error" TEXT,
  ADD COLUMN "page_count" INTEGER;

CREATE TABLE "document_blocks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL, "org_id" UUID NOT NULL,
  "kind" "DocumentBlockKind" NOT NULL, "level" INTEGER,
  "text" TEXT NOT NULL DEFAULT '', "html" TEXT, "data" JSONB,
  "anchor" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "parent_id" UUID, "page" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_blocks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_blocks_document_id_anchor_key" ON "document_blocks"("document_id","anchor");
CREATE INDEX "document_blocks_document_id_ordinal_idx" ON "document_blocks"("document_id","ordinal");
CREATE INDEX "document_blocks_parent_id_idx" ON "document_blocks"("parent_id");
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "document_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
