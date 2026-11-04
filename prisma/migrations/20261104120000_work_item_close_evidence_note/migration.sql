-- The closing rule: an item that closes without a supporting file records why
-- one wasn't needed (src/lib/workflow/closing-rule.ts). Nullable, no default:
-- every existing item closed before the rule existed, so it has nothing to
-- record. Safe to re-run.
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "close_evidence_note" TEXT;
