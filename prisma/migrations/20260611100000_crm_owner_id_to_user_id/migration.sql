-- The CRM Owner picker historically stored the OrgMember membership-record id in
-- crm_contacts.owner_id, but the ABAC engine's `owns_resource` rule compares
-- ownerId to the acting user's User.id — so owner-scoped grants/denies on
-- CRM_UPDATE/CRM_DELETE never matched the real owner. The UI now writes User.id;
-- this back-fills existing rows from OrgMember.id -> the member's user_id.
--
-- Deterministic + safe: it only rewrites rows whose owner_id currently equals an
-- existing org_members.id. Rows already holding a user_id won't match (ids are
-- distinct UUIDs), and NULLs are untouched — so it's also idempotent (a re-run
-- finds nothing left to convert).
UPDATE "crm_contacts" c
SET "owner_id" = om."user_id"
FROM "org_members" om
WHERE c."owner_id" = om."id"
  AND c."owner_id" IS NOT NULL;
