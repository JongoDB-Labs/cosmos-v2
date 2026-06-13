-- A key prefix must be unique within an org so verifyApiKey can use a single
-- findUnique on (org_id, prefix) and a prefix collision can never shadow another
-- key. ADDITIVE — prefixes are 6 random bytes, so existing rows don't collide.
CREATE UNIQUE INDEX "api_keys_org_id_prefix_key" ON "api_keys"("org_id", "prefix");
