import { prisma } from "@/lib/db/client";
import { resolvePermissions } from "./check";
import { coerceRules, type AbacRule } from "@/lib/abac/engine";
import type { OrgRole } from "@prisma/client";

/**
 * The actor's fully-resolved access state for an org, used by BOTH permission
 * seams (getAuthContext for HTTP routes, loadActorPermissions for AI tools) so
 * work-role grants + ABAC rules are folded in EXACTLY ONCE.
 *
 * `permissions` is purely WIDENED by work-role grants (role base | stored
 * override | Σ grants) — it can never lose a bit, so adding work-roles can
 * never lock anyone out. `abacRules` (member rules ++ assigned work-role
 * policies) only NARROW, and only when evaluated via requireAccess(). The
 * resolved BigInt + rules stay server-side; never serialize `permissions`.
 */
export interface EffectivePermissions {
  orgRole: OrgRole;
  permissions: bigint;
  /**
   * Role base | explicit per-member override, EXCLUDING work-role grants. This
   * is the ceiling used when authoring/assigning work-roles: granting is bounded
   * by the permissions the actor holds *by their org role*, never by permissions
   * they only hold *via a work-role they were assigned* — otherwise a member
   * could launder a self-assigned grant into new roles (escalation feedback
   * loop). `permissions` (the widened set) is still used for ordinary access
   * checks; `basePermissions` is only the grant ceiling.
   */
  basePermissions: bigint;
  abacRules: AbacRule[];
}

export async function loadEffectivePermissions(
  orgId: string,
  userId: string,
): Promise<EffectivePermissions | null> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: {
      role: true,
      permissions: true,
      abacRules: true,
      workRoles: {
        select: { workRole: { select: { grants: true, policies: true } } },
      },
    },
  });
  if (!member) return null;

  let grants = 0n;
  const workRolePolicies: AbacRule[] = [];
  for (const assignment of member.workRoles) {
    grants |= BigInt(assignment.workRole.grants);
    workRolePolicies.push(...coerceRules(assignment.workRole.policies));
  }

  const basePermissions = resolvePermissions(member.role, member.permissions);
  return {
    orgRole: member.role,
    permissions: basePermissions | grants,
    basePermissions,
    abacRules: [...coerceRules(member.abacRules), ...workRolePolicies],
  };
}
