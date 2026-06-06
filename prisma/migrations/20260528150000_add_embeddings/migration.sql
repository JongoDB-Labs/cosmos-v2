-- RAG / semantic search: per-row search vectors.
--
-- Stored as JSONB rather than pgvector(384) because the `vector` extension
-- isn't installed on this database. The shape currently produced by
-- src/lib/rag/embed.ts is `{ "tokens": string[], "tf": number[] }` — a small
-- token-frequency bag scored with JS-side cosine similarity. When pgvector
-- becomes available, swap these columns to `vector(384)` in a follow-up
-- migration and update embed.ts to emit a dense vector.

-- AlterTable
ALTER TABLE "notes" ADD COLUMN "search_vector" JSONB;

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN "search_vector" JSONB;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "search_vector" JSONB;

-- AlterTable
ALTER TABLE "sync_meetings" ADD COLUMN "search_vector" JSONB;
