-- Work-roles to assign on invite acceptance (granular RBAC/ABAC at invite time).
ALTER TABLE "invitations" ADD COLUMN "work_role_ids" TEXT[] NOT NULL DEFAULT '{}';
