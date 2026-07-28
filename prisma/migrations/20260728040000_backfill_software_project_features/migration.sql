-- Give projects created from the STALE software template the feature set that
-- template was supposed to hand them.
--
-- 20260728010000 fixed three things: the template itself, projects carrying the
-- legacy "cycle" key, and the board names. It missed the case actually reported:
-- a project created from the BROKEN template, which listed
--   enabledFeatures: ["goal", "milestone", "risk"]
-- — no "interval" AND no "cycle". The project header shows Intervals only when
-- one of those two keys is present, and that backfill was scoped
-- `WHERE 'cycle' = ANY(enabled_features)`, so a project holding neither fell
-- straight through it. The Intervals button was therefore unreachable: absent
-- from the header, and (until the settings toggle) with no way to add it.
--
-- SCOPING — why "risk" identifies exactly the affected rows:
-- "risk" is not in TOGGLEABLE_FEATURES (that list has "risk-register"), and the
-- project PUT filters enabled_features down to that list on every save. So a row
-- still holding "risk" has NEVER been through the settings UI: its feature set
-- is the untouched template default, not a choice anyone made. That makes
-- replacing it safe — we are correcting a bad default, not overriding a user.
-- A project whose features were ever edited has already lost "risk" and is left
-- alone here, even if it lacks "interval", because that absence may be deliberate.
UPDATE projects p
SET enabled_features = ARRAY[
      'goal','milestone','interval','roadmap','pm-dashboard',
      'risk-register','change-log','blocked-items','schedule-variance',
      'deliverables-tracker'
    ]
FROM project_templates pt
WHERE p.project_template_id = pt.id
  AND pt.org_id IS NULL
  AND pt.is_built_in = true
  AND pt.slug = 'software'
  AND 'risk' = ANY(p.enabled_features)
  AND NOT ('interval' = ANY(p.enabled_features));
