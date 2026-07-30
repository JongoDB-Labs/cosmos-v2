-- Fix the dead feature keys in the six remaining built-in sector templates, and
-- repair the projects already created from them.
--
-- Same defect the software template had in 2.243.0/2.243.1, in six more places.
-- "risk", "decision" and "meeting_note" are not in TOGGLEABLE_FEATURES, so the
-- project PUT filters them out and they never drove any surface — the real key
-- is "risk-register". None of the six set "interval" either, so a project made
-- from any of them had no Intervals button, despite every one of these templates
-- declaring intervalKinds (PHASE/MODULE/EVENT_DAY/RUN/RELEASE).
--
-- Per-sector calls made by the product owner (2026-07-29):
--   aec, consulting, manufacturing, ops -> "risk" becomes pm-dashboard +
--     risk-register. Both are required: pm-nav.tsx is the only navigation into
--     /pm-dashboard/*, and board-tabs.tsx renders that tab only when
--     "pm-dashboard" is on, so risk-register alone is a page with no way in.
--   education, event -> "risk" is simply dropped; the GovCon PM suite is the
--     wrong surface for a course or an event.
--   all six -> "interval" added.
--
-- The seed already carries these values, but the seed only runs at bootstrap,
-- while `prisma migrate deploy` runs on every deploy. That is why this is a
-- migration and not a seed change alone.
--
-- cycleNavLabel is left in place (unlike the software refresh, which stripped
-- it). Nothing reads it, so it is inert either way, but it records the intended
-- per-sector term — "Phases", "Days", "Runs" — which is exactly the information
-- needed if that label is ever wired through to the header button.

-- 1) The templates themselves.
UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["kpi","milestone","interval","pm-dashboard","risk-register"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'aec';

UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["goal","kpi","milestone","interval","pm-dashboard","risk-register"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'consulting';

UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["goal","milestone","interval"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'education';

UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["kpi","milestone","interval"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'event';

UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["kpi","interval","pm-dashboard","risk-register"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'manufacturing';

UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      '["kpi","interval","pm-dashboard","risk-register"]'::jsonb,
      true
    )
WHERE org_id IS NULL AND is_built_in = true AND slug = 'ops';

-- 2) Projects already created from the broken templates.
--
-- SCOPING — why "risk" identifies exactly the affected rows, and only those:
-- "risk" is not in TOGGLEABLE_FEATURES, and the project PUT filters
-- enabled_features down to that list on every save. So a project still holding
-- "risk" has NEVER been through the settings UI — its feature set is the
-- untouched template default, not a choice anyone made. Replacing it wholesale
-- corrects a bad default rather than overriding a user. All six templates
-- shipped "risk", so it is a reliable sentinel for every one of them.
--
-- A project whose features were ever edited has already lost "risk" and is left
-- alone here, even if it now lacks "interval": that absence may be deliberate.
--
-- Deliberately NOT also guarding on `NOT ('interval' = ANY(...))` the way the
-- software backfill did. None of these templates ever set "interval", so a row
-- holding "risk" cannot have acquired it — and if one somehow has both, the dead
-- keys still need clearing, which that guard would skip.
UPDATE projects p
SET enabled_features = ARRAY['kpi','milestone','interval','pm-dashboard','risk-register']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'aec'
  AND 'risk' = ANY(p.enabled_features);

UPDATE projects p
SET enabled_features = ARRAY['goal','kpi','milestone','interval','pm-dashboard','risk-register']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'consulting'
  AND 'risk' = ANY(p.enabled_features);

UPDATE projects p
SET enabled_features = ARRAY['goal','milestone','interval']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'education'
  AND 'risk' = ANY(p.enabled_features);

UPDATE projects p
SET enabled_features = ARRAY['kpi','milestone','interval']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'event'
  AND 'risk' = ANY(p.enabled_features);

UPDATE projects p
SET enabled_features = ARRAY['kpi','interval','pm-dashboard','risk-register']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'manufacturing'
  AND 'risk' = ANY(p.enabled_features);

UPDATE projects p
SET enabled_features = ARRAY['kpi','interval','pm-dashboard','risk-register']
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL AND pt.is_built_in = true AND pt.slug = 'ops'
  AND 'risk' = ANY(p.enabled_features);

-- 3) ORG-AUTHORED templates that picked up the dead keys from the old template
--    editor, which offered "Risks" / "Decisions" / "Meeting Notes" as checkboxes
--    (see template-editor.tsx, fixed alongside this migration).
--
--    These are user-authored, so their feature sets are NOT replaced — only the
--    three keys that provably do nothing are stripped, and "risk" is rewritten to
--    the real "risk-register" key with "pm-dashboard" added so it is reachable.
--    Everything the author deliberately chose is preserved.
UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      (
        SELECT COALESCE(jsonb_agg(DISTINCT f), '[]'::jsonb)
        FROM (
          SELECT jsonb_array_elements_text(default_config::jsonb -> 'enabledFeatures') AS k
        ) src,
        LATERAL (
          SELECT CASE
            WHEN src.k IN ('decision', 'meeting_note') THEN NULL
            WHEN src.k = 'risk' THEN 'risk-register'
            ELSE src.k
          END AS f
        ) mapped
        WHERE f IS NOT NULL
      ),
      true
    )
WHERE org_id IS NOT NULL
  AND jsonb_typeof(default_config::jsonb -> 'enabledFeatures') = 'array'
  AND (default_config::jsonb -> 'enabledFeatures') ?| ARRAY['risk', 'decision', 'meeting_note'];

-- Add "pm-dashboard" to the org templates that just gained "risk-register", so
-- the register they asked for is actually reachable from the board strip.
UPDATE project_templates
SET default_config = jsonb_set(
      default_config::jsonb,
      '{enabledFeatures}',
      (default_config::jsonb -> 'enabledFeatures') || '["pm-dashboard"]'::jsonb,
      true
    )
WHERE org_id IS NOT NULL
  AND jsonb_typeof(default_config::jsonb -> 'enabledFeatures') = 'array'
  AND (default_config::jsonb -> 'enabledFeatures') ? 'risk-register'
  AND NOT ((default_config::jsonb -> 'enabledFeatures') ? 'pm-dashboard');
