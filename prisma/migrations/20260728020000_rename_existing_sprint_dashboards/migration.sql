-- Rename the dashboard board on projects ALREADY created from the software
-- template.
--
-- 20260728010000 fixed the TEMPLATE, so projects created from then on get
-- "Sprint Health". It did not touch projects created earlier — they still carry
-- a board literally named "Sprint Dashboard", which is what a user reported
-- seeing on a project created before that release.
--
-- Deliberately narrow. Only boards that:
--   * are still named exactly "Sprint Dashboard" (the old default) — a team that
--     renamed theirs to something else chose that name and keeps it;
--   * are DASHBOARD type;
--   * belong to a project instantiated from the built-in software template.
-- A project from another sector's template, or one whose dashboard was renamed,
-- is left alone.
UPDATE boards b
SET name = 'Sprint Health'
FROM projects p, project_templates pt
WHERE b.project_id = p.id
  AND p.project_template_id = pt.id
  AND pt.org_id IS NULL
  AND pt.is_built_in = true
  AND pt.slug = 'software'
  AND b.type = 'DASHBOARD'
  AND b.name = 'Sprint Dashboard';
