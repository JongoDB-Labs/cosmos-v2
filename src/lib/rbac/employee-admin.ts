import { ForbiddenError } from "@/lib/rbac/check";
import { Permission, hasAnyPermission } from "@/lib/rbac/permissions";

/**
 * "May this actor administer the org's employee records?"
 *
 * Creating employees and setting who supervises whom is deliberately NOT
 * something the subject can do. A worker who nominates their own approver
 * defeats the control the approval workflow exists to provide, so this needs a
 * people- or finance-admin permission.
 *
 * Either works. An HR admin without finance access still has to be able to run
 * the org chart, and gating on FINANCE_MANAGE alone (as the employee record
 * historically did) locks them out of it.
 *
 * Shared rather than re-declared per route so the two surfaces that create and
 * wire up employees cannot drift apart on who is allowed to use them — a
 * mismatch would show up as an admin who can add people but not give them a
 * supervisor, leaving the approval chain half-built.
 */
export function requireEmployeeAdmin(permissions: bigint): void {
  if (
    !hasAnyPermission(
      permissions,
      Permission.FINANCE_MANAGE,
      Permission.ORG_MANAGE_MEMBERS,
    )
  ) {
    throw new ForbiddenError("Missing required permission");
  }
}
