-- Per-user, per-project tab layout preferences (order/hidden/labels/default),
-- keyed by projectId inside the JSON. Additive + backward-compatible.
ALTER TABLE "user_preferences" ADD COLUMN "tab_prefs" JSONB NOT NULL DEFAULT '{}';
