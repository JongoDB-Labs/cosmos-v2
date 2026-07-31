-- Re-sync the built-in "Project Manager" work role to its narrowed catalog value.
--
-- seedBuiltinWorkRoles() upserts the catalog and would heal this by itself, but
-- its only production caller is ORG CREATION — so an existing org would keep the
-- old grants indefinitely. This applies the same value at deploy time.
--
-- Removed (11): PROJECT_MANAGE, PROJECT_UPDATE, SPRINT_CREATE, SPRINT_UPDATE,
-- SPRINT_COMPLETE, BOARD_UPDATE, BOARD_DELETE, BOARD_MANAGE, ITEM_DELETE,
-- ITEM_BULK_EDIT, OKR_DELETE.
--
-- A work role is ADDITIVE on top of the org role, so those bits made a Project
-- Manager an administrator of EVERY project in the org. Each remains available
-- inside a project they MANAGE, via requireProjectManage's
-- "org-wide bit OR manager of this project" rule.
--
-- The literal below is permissionMaskFromKeys(<catalog permissions>) serialized
-- by maskToDb. builtin-work-roles.test.ts recomputes it from the catalog and
-- fails if the two ever drift apart.
--
-- Scoped by the reserved built-in key, so a cloned or custom role of the same
-- name is untouched.
UPDATE "work_roles"
SET "grants" = '283954336511455713695124606159872'
WHERE "key" = 'builtin.project-manager'
  AND "is_built_in" = true;
