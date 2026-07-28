-- Bring the built-in Software Project template up to date on instances that were
-- seeded before it changed, and stop the Intervals button from disappearing.
--
-- The sector seed already says "Sprint Health" and has done for a while, but the
-- seed only runs at bootstrap — nothing re-runs it on deploy. So a running
-- instance still creates every new software project with a board called "Sprint
-- Dashboard" and without the Intervals header button, while the repo looks
-- correct. `prisma migrate deploy` DOES run on every deploy, which is why this
-- is a migration rather than a seed change alone.
--
-- Scoped to BUILT-IN rows (org_id IS NULL AND is_built_in) throughout: a tenant
-- that renamed its own copy of a template keeps that name.

-- 1) The board rename the seed already made.
UPDATE board_templates
SET name = 'Sprint Health'
WHERE org_id IS NULL
  AND is_built_in = true
  AND slug = 'software.dashboard'
  AND name = 'Sprint Dashboard';

-- 2) The template's feature set.
--    "risk" was never a valid key (TOGGLEABLE_FEATURES has "risk-register"), so
--    it silently did nothing; "interval" was absent, which is the actual reason a
--    new software project had no Intervals button.
UPDATE project_templates
SET default_config = jsonb_set(
      (default_config::jsonb - 'cycleNavLabel'),
      '{enabledFeatures}',
      '["goal","milestone","interval","roadmap","pm-dashboard","risk-register","change-log","blocked-items","schedule-variance","deliverables-tracker"]'::jsonb,
      true
    )
WHERE org_id IS NULL
  AND is_built_in = true
  AND slug = 'software';

-- 3) Backfill "interval" onto every project that still carries only the legacy
--    "cycle" key.
--
--    This is the load-bearing part. The project PUT filters enabled_features down
--    to TOGGLEABLE_FEATURES, which contains "interval" and NOT "cycle" — so the
--    next time anyone toggled any feature on such a project, "cycle" was dropped
--    and its Intervals button vanished for good, with no way to restore it from
--    the UI. Adding "interval" alongside makes that filtering harmless.
--
--    "cycle" is left in place deliberately: removing it is the PUT's job, and
--    doing it here would rewrite rows this migration has no need to touch.
UPDATE projects
SET enabled_features = array_append(enabled_features, 'interval')
WHERE 'cycle' = ANY(enabled_features)
  AND NOT ('interval' = ANY(enabled_features));

-- 4) Board-set changes the seed makes, applied to instances that already ran it.
--    Same built-in scoping: an org that renamed its own copy keeps its name.
UPDATE board_templates
SET name = 'Timeline / Gantt'
WHERE org_id IS NULL
  AND is_built_in = true
  AND slug = 'software.release-timeline'
  AND name = 'Release Timeline';

-- 5) The Roadmap board the template never had.
--    Its filters key off roadmap NODES rather than work items — which is the
--    substance of "filters specific to the board's data type" — so a template
--    without it leaves new projects unable to plan above the sprint at all.
INSERT INTO board_templates (id, slug, name, category, board_type, sort_order, sector, project_template_id, is_built_in, is_published, created_at)
SELECT gen_random_uuid(), 'software.roadmap', 'Roadmap', 'planning', 'ROADMAP', 7, 'software', pt.id, true, true, now()
FROM project_templates pt
WHERE pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'software'
  AND NOT EXISTS (
    SELECT 1 FROM board_templates b WHERE b.org_id IS NULL AND b.slug = 'software.roadmap'
  );
