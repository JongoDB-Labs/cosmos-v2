-- Phase 3 (RAG): real semantic search over in-boundary MiniLM embeddings.
--
-- Adds a 384-dim pgvector column to each searchable table and an HNSW cosine
-- index for ANN ranking. The legacy `search_vector` JSON columns are left in
-- place (no longer written) and can be dropped in a later migration.
--
-- pgvector ships in the `pgvector/pgvector:pg16` image used by docker-compose.
-- This migration is pure SQL and is verified end-to-end in Docker (Phase 3 Task 4).

CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding columns (nullable; backfilled by scripts/backfill-embeddings.ts and
-- written on every create/update via storeEmbedding()).
ALTER TABLE "notes"         ADD COLUMN "embedding" vector(384);
ALTER TABLE "work_items"    ADD COLUMN "embedding" vector(384);
ALTER TABLE "contracts"     ADD COLUMN "embedding" vector(384);
ALTER TABLE "sync_meetings" ADD COLUMN "embedding" vector(384);

-- HNSW indexes for approximate-nearest-neighbour cosine ranking (`<=>`).
CREATE INDEX "notes_embedding_idx"         ON "notes"         USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "work_items_embedding_idx"    ON "work_items"    USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "contracts_embedding_idx"     ON "contracts"     USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "sync_meetings_embedding_idx" ON "sync_meetings" USING hnsw ("embedding" vector_cosine_ops);
