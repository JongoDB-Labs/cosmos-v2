-- First-class CRM contact attributes that the edit form + contact card always
-- read/wrote (and the client type declared) but had no columns for — so edits
-- were silently dropped on save. Additive + nullable; the existing table-level
-- grants to cosmos_app cover new columns. Idempotent (IF NOT EXISTS) so a re-run
-- is a no-op.
ALTER TABLE "crm_contacts" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "crm_contacts" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "crm_contacts" ADD COLUMN IF NOT EXISTS "company" TEXT;
ALTER TABLE "crm_contacts" ADD COLUMN IF NOT EXISTS "title" TEXT;
