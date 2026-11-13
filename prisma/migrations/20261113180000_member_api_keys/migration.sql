-- "Members can create their own API keys", per org. On by default, so every
-- existing org gets member self-service keys. Off: only holders of
-- API_KEY_MANAGE may mint, and keys made by anyone else stop authenticating
-- until it is turned on again (src/lib/auth/api-key-policy.ts).
--
-- Adding a column with a constant default is a catalog-only change in
-- Postgres 11+, so it does not rewrite the table.
--
-- Two statements, which migrate deploy commits one at a time: IF NOT EXISTS
-- on both lets a deploy that stopped between them run again.
ALTER TABLE "org_security_settings" ADD COLUMN IF NOT EXISTS "member_api_keys_enabled" BOOLEAN NOT NULL DEFAULT true;

-- The IdP connection the session that made a key signed in through, when it
-- was single sign-on. Where the org requires single sign-on, a key made by
-- someone who can't manage keys works only if this names the org's connection.
-- Null on every existing key, so under that requirement those keys stop
-- working for such people until they make a new one through the IdP.
-- Nullable with no default: catalog-only, no table rewrite.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "idp_conn_id" UUID;
