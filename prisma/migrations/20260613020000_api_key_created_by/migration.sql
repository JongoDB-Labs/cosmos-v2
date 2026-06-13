-- Bind an API key to the user who minted it (the originating principal — every
-- action via the key is attributed to them). ADDITIVE. ON DELETE SET NULL so a
-- departed user's keys are auto-disabled (verifyApiKey rejects null createdById).
ALTER TABLE "api_keys" ADD COLUMN "created_by_id" UUID;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "api_keys_created_by_id_idx" ON "api_keys"("created_by_id");
