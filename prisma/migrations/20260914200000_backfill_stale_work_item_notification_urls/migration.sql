-- COSMOS-194. Backfill notification rows written before the COSMOS-191 URL fix.
--
-- Mention/comment notifications used to store "/projects/{KEY}/work-items/{uuid}".
-- There is no work-items route anywhere under src/app/(dashboard) — the dropdown
-- re-prefixes the org slug and pushes "/{orgSlug}/projects/{KEY}/work-items/{uuid}",
-- which resolves to nothing and renders a 404. The writer was fixed to store
-- "/{orgSlug}/issues?item={uuid}" (the app's real work-item deep link, read by
-- issues-view.tsx via searchParams.get("item")), but the rows already on disk were
-- never rewritten, so every older "you were mentioned" notification is a dead link.
--
-- The uuid in the old path IS the work item id, so the rewrite is mechanical. Rows
-- whose work item has since been deleted are rewritten too: /issues with an unknown
-- ?item= simply opens no panel, which beats a 404. Nothing is deleted here — the
-- notification itself is still a true record of what happened.
--
-- The slug comes from the row's owning org, never a literal: these rows span orgs,
-- and a wrong slug is the same 404 one level along. An org_id with no organizations
-- row (there is no FK on notifications) falls back to the org-relative "/issues?…",
-- which the dropdown prefixes with the reader's current slug.

UPDATE "notifications" n
SET "url" =
  coalesce(
    (SELECT '/' || o."slug" FROM "organizations" o WHERE o."id" = n."org_id"),
    ''
  )
  || '/issues?item='
  || regexp_replace(n."url", '^/projects/.*/work-items/([^/?#]*).*$', '\1')
WHERE n."url" LIKE '/projects/%/work-items/%';

DO $verify$
DECLARE
  leftover INT;
BEGIN
  SELECT count(*) INTO leftover
  FROM "notifications" WHERE "url" LIKE '/projects/%/work-items/%';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'notification URL backfill left % row(s) on the dead work-items path', leftover;
  END IF;
END
$verify$;
