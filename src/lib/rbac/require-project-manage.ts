import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";

/**
 * "May this actor administer THIS project?" — the write-side twin of
 * `requireProjectRead`.
 *
 * A project's MANAGER should be able to run it: settings, boards, the PM
 * dashboard, sprints, milestones, risks, deliverables. They could not. Around 44
 * mutating routes under projects/[projectId] gated on an ORG-WIDE bit alone —
 * usually PROJECT_UPDATE, which an ordinary member does not hold — so someone
 * made MANAGER of a project still could not add a milestone to it. The only way
 * to make them effective was to widen their ORG role, which is exactly the
 * over-granting this is meant to undo.
 *
 * Two ways in, and either suffices:
 *
 *   - the org-wide bit the route already required — unchanged for everyone who
 *     holds it, so this takes nothing away from anyone, or
 *   - MANAGER of this project, via `canManageProject`.
 *
 * Throws `ForbiddenError` exactly like `requirePermission`, so a call site swaps
 * one line and keeps its existing error handling.
 *
 * Deliberately NOT used for deleting the project itself: everything reachable
 * here is scoped to the project and recoverable, and removing the project is
 * neither. That stays with the org owner/admin.
 */
export async function requireProjectManage(
  ctx: AuthContext,
  projectId: string,
  orgWideBit: bigint = Permission.PROJECT_UPDATE,
): Promise<void> {
  if (hasPermission(ctx.permissions, orgWideBit)) return;
  if (await canManageProject(ctx, projectId)) return;
  throw new ForbiddenError(
    "You must be a manager of this project, or hold the org-wide permission, to do that.",
  );
}

/**
 * Boolean form, for server components deciding whether to render an affordance.
 * The route still enforces; this only stops the UI offering a button that would
 * 403.
 */
export async function canAdministerProject(
  ctx: AuthContext,
  projectId: string,
  orgWideBit: bigint = Permission.PROJECT_UPDATE,
): Promise<boolean> {
  if (hasPermission(ctx.permissions, orgWideBit)) return true;
  return canManageProject(ctx, projectId);
}
