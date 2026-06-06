-- Generated tsvector column + GIN index for full-text search on chat messages.
-- The column is STORED + GENERATED ALWAYS, so application code never writes
-- to it; Postgres maintains it automatically on insert/update of `content`.

ALTER TABLE "chat_messages"
  ADD COLUMN "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED;

CREATE INDEX "chat_messages_content_tsv_idx" ON "chat_messages" USING GIN ("content_tsv");
