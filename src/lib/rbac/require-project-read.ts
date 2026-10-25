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
  await requireProjectVisible(ctx, projectId);
}

/**
 * The visibility half of `requireProjectRead`, for a WRITE under a project.
 *
 * Writes gate on their own action through `requireAccess` with the resource's
 * attributes (creator, assignee, owner), which `requireProjectRead` would drop,
 * so they call this beside it. Without it a project that opted into
 * `teamScopedAccess` hid its items from non-members while still letting them
 * create, delete, duplicate, merge and comment on them by id: the visibility
 * question decides whether a non-member may act at all (project-role.ts).
 *
 * Call it right after authentication, before the resource is looked up, so a
 * non-member can't tell a real id from a missing one by 404 versus 403.
 * Names no permission bit: it narrows, it never adds a requirement.
 */
export async function requireProjectVisible(ctx: AuthContext, projectId: string): Promise<void> {
  if (!(await isProjectVisible(ctx, projectId))) {
    // Same message shape as a permission denial: whether a project exists but
    // is not visible, versus does not exist, is not something an actor without
    // access should be able to distinguish.
    throw new ForbiddenError("Access denied by policy");
  }
}

/**
 * For a record that may belong to a project (a meeting, a contract, a time
 * entry): true when it belongs to none, or to one the actor can see. A write by
 * id answers a hidden record with the same 404 as a missing one, as its read
 * does.
 */
export async function inVisibleProject(ctx: AuthContext, projectId: string | null | undefined): Promise<boolean> {
  return !projectId || isProjectVisible(ctx, projectId);
}

/** `requireProjectVisible` for a project the caller may name (a body's `projectId`), when they name one. */
export async function requireProjectVisibleIf(ctx: AuthContext, projectId: string | null | undefined): Promise<void> {
  if (projectId) await requireProjectVisible(ctx, projectId);
}
