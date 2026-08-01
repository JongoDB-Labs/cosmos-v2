-- Take TIME_APPROVE off the built-in "Project Manager" work role.
--
-- Running a project and signing off company time are different authorities.
-- Approving hours commits them to payroll, to a CLIN and potentially to an
-- invoice; managing delivery needs none of that. Bundling them meant that
-- granting someone a project silently made them an approver of everyone's time
-- — in the first org to hit this, 16 people held the role, so every submitted
-- week was routed to all 16 and none of them had been chosen for that job.
--
-- Approval now belongs to whoever SUPERVISES the worker, or to the built-in
-- "Reviewer / Approver" role, which exists precisely so approval can be granted
-- without also handing someone a project.
--
-- NOBODY IS AUTO-GRANTED the Reviewer / Approver role here. Re-granting the
-- authority we are separating would make this migration a no-op with extra
-- steps; who approves time is a decision for each org to make deliberately.
-- Until they do, submissions fall back to the org's OWNER/ADMIN pool, which is
-- the documented behaviour when no supervisor is named.
--
-- seedBuiltinWorkRoles() upserts the catalog, but its only production caller is
-- ORG CREATION — so an existing org would keep the old grants indefinitely.
-- This applies the new value at deploy time.
--
-- The literal is permissionMaskFromKeys(<catalog permissions>) serialized by
-- maskToDb; it differs from the previous value by exactly 2^84 (TIME_APPROVE)
-- and nothing else. builtin-work-roles.test.ts recomputes it from the catalog
-- and fails if the two ever drift apart.
--
-- Scoped by the reserved built-in key, so a cloned or custom role of the same
-- name is untouched — an org that deliberately built its own approving PM role
-- keeps it.
UPDATE "work_roles"
SET "grants" = '283954317168642599861057810861056'
WHERE "key" = 'builtin.project-manager'
  AND "is_built_in" = true;
