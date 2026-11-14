-- The IdP connection the session that made a calendar feed link signed in
-- through, when it was single sign-on. A link is a bearer credential like an
-- API key, so it is held to the same rule (src/lib/auth/api-key-policy.ts):
-- where the org requires single sign-on, a link is served only if this names
-- the org's connection. Null on every existing link, so under that requirement
-- those links stop until their owner makes a new one through the IdP.
--
-- One statement, so it applies whole. Nullable with no default: catalog-only,
-- no table rewrite. IF NOT EXISTS lets an interrupted deploy run again.
ALTER TABLE "calendar_feeds" ADD COLUMN IF NOT EXISTS "idp_conn_id" UUID;
