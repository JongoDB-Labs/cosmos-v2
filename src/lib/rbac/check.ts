import { OrgRole } from "@prisma/client";
import { hasPermission, RolePermissions } from "./permissions";
import type { AbacRule } from "@/lib/abac/engine";

export interface AuthContext {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  permissions: bigint;
  /** Effective permissions EXCLUDING work-role grants (role base | explicit
   *  per-member override). The ceiling for authoring/assigning work-roles, so a
   *  self-assigned grant can't be laundered into new roles. NOT for ordinary
   *  access checks — use `permissions` for those. */
  basePermissions: bigint;
  /** Collected ABAC rules (member + assigned work-role policies). Evaluated
   *  by requireAccess(); empty for orgs with no work-roles/policies. */
  abacRules: AbacRule[];
}

export function resolvePermissions(
  orgRole: OrgRole,
  storedPermissions: bigint | null
): bigint {
  const roleKey = orgRole as keyof typeof RolePermissions;
  const basePermissions = RolePermissions[roleKey] ?? 0n;
  return basePermissions | (storedPermissions ?? 0n);
}

export function requirePermission(
  ctx: AuthContext,
  required: bigint
): void {
  if (!hasPermission(ctx.permissions, required)) {
    throw new ForbiddenError("Missing required permission");
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
