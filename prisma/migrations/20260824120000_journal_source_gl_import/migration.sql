-- A journal entry can now say it came from importing an external trial balance.
--
-- Worth being able to tell apart: a GL_IMPORT entry is an adjusting figure
-- reconciling the ledger to a bookkeeping system elsewhere, not a transaction
-- that happened here. Anything auditing where a number came from needs to see
-- that difference, and `source` is where the ledger records it.
ALTER TYPE "JournalSource" ADD VALUE 'GL_IMPORT';
