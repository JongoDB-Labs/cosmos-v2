-- Model + reasoning effort: configurable per org, and recorded per build.
--
-- Every build agent ran with a hardcoded "opus" and no effort level. These four
-- columns make that a choice and, crucially, make it AUDITABLE: the settings an
-- org holds today are not evidence of what a build last week ran with, so the
-- values are stamped onto the build's own turn rows.
--
-- All nullable, no defaults, deliberately. NULL on foreman_harness_settings
-- means "unset" — for effort that is the SDK's own default, which is exactly
-- what every existing build used, so backfilling a level here would silently
-- change behaviour for every org that never asked for it. NULL on
-- foreman_build_turn means "this build predates the column", which the console
-- renders as "not recorded" rather than substituting a current setting.

ALTER TABLE "foreman_harness_settings"
  ADD COLUMN IF NOT EXISTS "model" TEXT,
  ADD COLUMN IF NOT EXISTS "effort" TEXT;

ALTER TABLE "foreman_build_turn"
  ADD COLUMN IF NOT EXISTS "model" TEXT,
  ADD COLUMN IF NOT EXISTS "effort" TEXT;
