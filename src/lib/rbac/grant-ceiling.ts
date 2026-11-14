import type { OrgRole } from "@prisma/client";
import { ForbiddenError, type AuthContext } from "./check";
import { Permission, RolePermissions, isPermissionSubset, maskFromDb } from "./permissions";

/**
 * The bits an org-role grant may carry although the granter does not hold them.
 *
 * Only ORG_MANAGE_BILLING, so that an admin can still make someone a Billing
 * admin, as they always could. No route checks that bit today. Whether it should
 * stay grantable by admins is the owner's decision: removing it from this mask
 * makes the Billing admin role grantable by owners only, which is what the work
 * role ceiling already does with the same bit.
 */
export const GRANTABLE_WITHOUT_HOLDING: bigint = Permission.ORG_MANAGE_BILLING;

export const OWNER_ONLY_MESSAGE = "Only an owner can grant the owner role";
export const CEILING_MESSAGE = "You can't grant a role with permissions you don't have.";

export type Granter = Pick<AuthContext, "orgRole" | "basePermissions">;

/** A granter for the ceiling on current access, which also reads the base before restrictions. */
export type CurrentAccessGranter = Pick<AuthContext, "orgRole" | "basePermissions" | "unrestrictedBasePermissions">;

/**
 * Why `granter` may not give someone `role` (plus `extra` bits, e.g. a stored
 * per-member override or work-role grants that come back on reinstatement), or
 * null when they may.
 *
 * Two rules, for every path that sets an org role:
 *  1. Only an owner may make someone an owner.
 *  2. The permissions granted must be a subset of the granter's
 *     `basePermissions`: their role plus any per-member override, never what
 *     they hold through a work role. That is the ceiling work roles already
 *     use, so a member who was given ORG_MANAGE_MEMBERS by a work role can
 *     manage members at their own level but can't create an admin.
 *
 * An admin may grant admin: the admin mask is a subset of itself. For an API
 * key, `basePermissions` is already narrowed by the key's scopes.
 */
export function orgRoleGrantRefusal(granter: Granter, role: OrgRole, extra = 0n): string | null {
  if (role === "OWNER" && granter.orgRole !== "OWNER") return OWNER_ONLY_MESSAGE;
  const granted = (RolePermissions[role] ?? 0n) | extra;
  if (!isPermissionSubset(granted & ~GRANTABLE_WITHOUT_HOLDING, granter.basePermissions)) {
    return CEILING_MESSAGE;
  }
  return null;
}

/** Throwing form of {@link orgRoleGrantRefusal}: a ForbiddenError (403). */
export function assertCanGrantOrgRole(granter: Granter, role: OrgRole, extra = 0n): void {
  const refusal = orgRoleGrantRefusal(granter, role, extra);
  if (refusal) throw new ForbiddenError(refusal);
}

/** The member fields {@link heldBeyondRole} reads, for a Prisma `select` or `include`. */
export const HELD_WORK_ROLES = { select: { workRole: { select: { grants: true } } } } as const;

/**
 * What a member holds beyond their org role: their stored per-member override
 * plus the grants of every work role they hold. Changing their role or removing
 * them changes or ends all of it, and reinstating them brings all of it back,
 * so every ceiling on a member counts all of it.
 */
export function heldBeyondRole(member: {
  permissions: string;
  workRoles: { workRole: { grants: string } }[];
}): bigint {
  return member.workRoles.reduce(
    (acc, a) => acc | maskFromDb(a.workRole.grants),
    maskFromDb(member.permissions),
  );
}

export const OWNER_CHANGE_MESSAGE = "Only an owner can change or remove an owner.";
export const CURRENT_ACCESS_MESSAGE = "You can't change or remove access beyond your own.";

/**
 * The ceiling on current role: why `granter` may not change or remove a member
 * (or an invitation) that holds `role` plus `extra` bits today, or null when
 * they may.
 *
 * It is the grant ceiling applied to what the target has now: you may modify
 * only what you could have granted. Without it, a member who manages members
 * through a work role could demote or remove an admin they could never have
 * made. Every path that changes or removes a member runs both this (on the
 * current access) and {@link orgRoleGrantRefusal} (on the new access).
 *
 * Like with like: what the target holds is counted without the org's
 * restrictions, so the caller's ceiling is too (`unrestrictedBasePermissions`).
 * A restriction takes its bits from the caller's base and from the target
 * alike; counted on one side only, a restriction on ITEM_CREATE, which a
 * member's role holds, stopped every admin from managing any member. Masking
 * BOTH sides instead would let a restriction hide what the target holds
 * beyond the caller: restrict SECURITY_MANAGE and someone who manages members
 * through a work role could remove a member whose work role grants it. Without
 * the field (a context not built from a member), the restricted base is used.
 * Granting does not change: {@link orgRoleGrantRefusal} stays on
 * `basePermissions`, since a grant outlives the restriction.
 */
export function currentAccessRefusal(granter: CurrentAccessGranter, role: OrgRole, extra = 0n): string | null {
  const ceiling = { orgRole: granter.orgRole, basePermissions: granter.unrestrictedBasePermissions ?? granter.basePermissions };
  const refusal = orgRoleGrantRefusal(ceiling, role, extra);
  if (!refusal) return null;
  return refusal === OWNER_ONLY_MESSAGE ? OWNER_CHANGE_MESSAGE : CURRENT_ACCESS_MESSAGE;
}

/** Throwing form of {@link currentAccessRefusal}: a ForbiddenError (403). */
export function assertCanChangeCurrentAccess(granter: CurrentAccessGranter, role: OrgRole, extra = 0n): void {
  const refusal = currentAccessRefusal(granter, role, extra);
  if (refusal) throw new ForbiddenError(refusal);
}

/**
 * The same ceiling for a work role: why `granter` may not change, delete,
 * assign or take away a work role granting `grants`, or null when they may.
 * Work roles use a plain subset of `basePermissions`, with no carve-out.
 */
export function workRoleCeilingRefusal(granter: Pick<Granter, "basePermissions">, grants: bigint): string | null {
  return isPermissionSubset(grants, granter.basePermissions) ? null : CURRENT_ACCESS_MESSAGE;
}

/** The org roles `granter` may hand out, in the order the UI lists them. */
export function grantableOrgRoles(granter: Granter): OrgRole[] {
  const all: OrgRole[] = ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"];
  return all.filter((r) => orgRoleGrantRefusal(granter, r) === null);
}
