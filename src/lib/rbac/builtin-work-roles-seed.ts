import { prisma } from "@/lib/db/client";
import { BUILTIN_WORK_ROLES } from "./builtin-work-roles";
import { permissionMaskFromKeys } from "./permissions";

/**
 * Seed (or re-sync) the built-in work-role catalog into a single org.
 * Idempotent: upserts each catalog entry by { orgId, key }, so re-running
 * heals any drift (renamed/tampered name, grants, isBuiltIn) back to the
 * canonical catalog values. Never deletes — an admin-cloned role or a role a
 * member still holds is untouched.
 *
 * Does NOT catch per-entry failures — a failed upsert throws and aborts the
 * loop. Callers that must not let a role-seed failure break their own flow
 * (e.g. org creation) wrap the call in their own best-effort catch.
 */
export async function seedBuiltinWorkRoles(orgId: string): Promise<void> {
  for (const role of BUILTIN_WORK_ROLES) {
    const grants = permissionMaskFromKeys(role.permissions);
    await prisma.workRole.upsert({
      where: { orgId_key: { orgId, key: role.key } },
      create: {
        orgId,
        key: role.key,
        name: role.name,
        description: role.description,
        grants,
        policies: [],
        isBuiltIn: true,
      },
      update: {
        name: role.name,
        description: role.description,
        grants,
        isBuiltIn: true,
      },
    });
  }
}
