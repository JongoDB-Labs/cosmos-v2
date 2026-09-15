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
  /**
   * True when this context came from an API KEY rather than an interactive
   * login. The OWNER break-glass in `evaluateAccess` is deliberately gated on
   * this: the break-glass exists so a human owner can never be locked out of
   * their own org, and a key is not a human — it is a credential handed to a
   * script, whose whole purpose is to reach LESS than the person who minted it.
   *
   * Without this flag the scope mask is computed and then thrown away for any
   * key an owner minted, which is most of them. Measured against production on
   * 2026-09-15: a key without ITEM_DELETE in any of its scopes deleted a work
   * item, because the break-glass returned true before the mask was consulted.
   */
  isApiKey?: boolean;
  /**
   * A hard ceiling on which projects this actor may touch, independent of role.
   *
   * `undefined` means unrestricted — every session has this, and nothing about
   * the cookie path changes. It is set only by a project-scoped API KEY, and it
   * is a CEILING rather than a grant: it can only ever narrow what the minting
   * user could already do.
   *
   * It is applied AFTER the role logic, deliberately. `getReadableProjectIds`
   * short-circuits to every project for an OWNER, and org administrators keep
   * access to every project by design — so a restriction evaluated earlier
   * would be skipped for exactly the people most likely to mint a key, and
   * "scope this key to one project" would quietly mean nothing.
   */
  projectScope?: readonly string[];
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

/** A business-rule / state-conflict violation — maps to HTTP 409, not 500. */
export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}
