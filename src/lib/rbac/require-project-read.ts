import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { type PermissionKey } from "@/lib/rbac/permissions";
import { requireAccess } from "@/lib/abac/require-access";
import { isProjectVisible } from "@/lib/rbac/project-access";

/**
 * The gate for reading anything that belongs to a project.
 *
 * Replaces `requirePermission(ctx, Permission.X_READ)` in the routes under
 * projects/[projectId]. The audit found 46 of them gating on the raw org-wide
 * bitmask with no project scoping at all, which meant team-scoped access held
 * on the org-wide Issues list and nowhere else: the same rows were readable by
 * asking the project's own endpoint for them.
 *
 * Two checks, in this order and for these reasons:
 *
 *   1. `requireAccess(ctx, action, { projectId })` — the action's own bit plus
 *      any ABAC policy. Identical to the requirePermission it replaces until an
 *      org authors a policy, so adopting it is inert on its own.
 *   2. `isProjectVisible` — team scoping. Deliberately NOT `canReadProject`,
 *      which also demands PROJECT_READ: routes gate on their own action bit and
 *      GUEST holds ITEM_READ *without* PROJECT_READ, so requiring it here would
 *      quietly revoke GUEST access to items on every unrestricted project.
 *
 * On a project that has not opted into `teamScopedAccess` — every project by
 * default — step 2 short-circuits to true and this is exactly the old
 * behaviour. That is what makes converting 46 routes at once safe.
 *
 * Throws ForbiddenError on denial, mirroring requirePermission's contract, so
 * call sites need no error handling of their own.
 */
export async function requireProjectRead(
  ctx: AuthContext,
  projectId: string,
  action: PermissionKey,
): Promise<void> {
  await requireAccess(ctx, action, { orgId: ctx.orgId, projectId });
  if (!(await isProjectVisible(ctx, projectId))) {
    // Same message shape as a permission denial: whether a project exists but
    // is not visible, versus does not exist, is not something an actor without
    // access should be able to distinguish.
    throw new ForbiddenError("Access denied by policy");
  }
}
