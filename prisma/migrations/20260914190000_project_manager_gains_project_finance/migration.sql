-- Project Manager gains FINANCE_READ_PROJECT.
--
-- The role could run a project but not see the fee it was being run against.
-- The only way to show someone that number was FINANCE_READ — the whole
-- practice's book, every project, plus the org administration that travels
-- with the roles carrying it. Firms grant it anyway, which is how a delivery
-- tool ends up with every project manager an administrator.
--
-- FINANCE_READ_PROJECT is the narrow grant: the same figures, restricted to
-- projects the holder is a member of. It adds NO org-wide visibility, which is
-- the same scoping this role already applies to project administration.
--
-- seedBuiltinWorkRoles() upserts the catalog, but its only production caller is
-- ORG CREATION — so an existing org would keep the old grants indefinitely.
-- This applies the new value at deploy time.
--
-- The literal is permissionMaskFromKeys(<catalog permissions>) serialized by
-- maskToDb; it differs from the previous value by exactly 2^121
-- (FINANCE_READ_PROJECT) and nothing else. builtin-work-roles.test.ts
-- recomputes it from the catalog and fails if the two ever drift apart.
--
-- Scoped by the reserved built-in key, so a cloned or custom role of the same
-- name is untouched.
UPDATE "work_roles"
SET "grants" = '2658739945887000388407475178371550208'
WHERE "key" = 'builtin.project-manager'
  AND "is_built_in" = true;
