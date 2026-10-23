import { prisma } from "@/lib/db/client";
import { resolvePermissions, type AuthContext } from "./check";
import { maskFromDb } from "./permissions";
import { coerceRules, type AbacRule } from "@/lib/abac/engine";
import type { OrgRole } from "@prisma/client";

/**
 * The actor's fully-resolved access state for an org, used by every seam that
 * resolves a USER (getAuthContext for sessions, verifyApiKey for the user behind
 * a key, `loadMemberAuthContext` for server-initiated jobs) so work-role grants
 * + ABAC rules are folded in EXACTLY ONCE. AI tools do NOT call this: they are
 * authorised against the caller's own AuthContext (see ai/executors/_ctx.ts).
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
    grants |= maskFromDb(assignment.workRole.grants);
    workRolePolicies.push(...coerceRules(assignment.workRole.policies));
  }

  const basePermissions = resolvePermissions(member.role, maskFromDb(member.permissions));
  return {
    orgRole: member.role,
    permissions: basePermissions | grants,
    basePermissions,
    abacRules: [...coerceRules(member.abacRules), ...workRolePolicies],
  };
}

/**
 * A session-shaped AuthContext for `userId` in `orgId`, built from the member's
 * stored permissions — what `getAuthContext` returns for that user's cookie,
 * minus the request-time floors (MFA, IP allowlist, idle timeout) a job has no
 * request to evaluate. `null` when the user is not a member.
 *
 * ONLY for server-initiated work that acts as a user WITHOUT an inbound
 * credential: an operator acceptance script, a scheduled job. Anything handling
 * a request must pass the AuthContext that request authenticated with instead.
 * Rebuilding it from the user id is precisely how an API key's scope mask and
 * project ceiling got dropped on the way into the AI tools — this returns the
 * user's FULL access, and there is no `isApiKey` or `projectScope` on it.
 */
export async function loadMemberAuthContext(
  orgId: string,
  userId: string,
): Promise<AuthContext | null> {
  const eff = await loadEffectivePermissions(orgId, userId);
  if (!eff) return null;
  return {
    userId,
    orgId,
    orgRole: eff.orgRole,
    permissions: eff.permissions,
    basePermissions: eff.basePermissions,
    abacRules: eff.abacRules,
  };
}
