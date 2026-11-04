-- Internal time categories: an entry with no project may say which kind of
-- internal time it is (overhead, business development, professional
-- development, or whatever the org calls its own). Nullable, no default:
-- every existing row is simply uncategorised, which is what it was.
--
-- Safe to re-run.
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "internal_category" TEXT;
