import { prisma } from "@/lib/db/client";
import { resolvePermissions, type AuthContext } from "./check";
import { Permission, maskFromDb } from "./permissions";
import { coerceRules, type AbacRule } from "@/lib/abac/engine";
import type { OrgRole } from "@prisma/client";

/**
 * The actor's fully-resolved access state for an org, used by every seam that
 * resolves a USER (getAuthContext for sessions, verifyApiKey for the user behind
 * a key, `loadMemberAuthContext` for server-initiated jobs) so work-role grants
 * + ABAC rules are folded in EXACTLY ONCE. AI tools do NOT call this: they are
 * authorised against the caller's own AuthContext (see ai/executors/_ctx.ts).
 *
 * `permissions` is WIDENED by work-role grants (role base | stored override |
 * Σ grants), so adding work-roles can never lock anyone out. The one thing
 * that takes bits away is the org's own actionRestrictions: a restriction with
 * NO conditions denies its actions outright, so those bits are removed here,
 * once, and every bit-only check (requirePermission, Cosmo's assertPermission)
 * honours it without knowing restrictions exist. Except for an OWNER's own
 * session, the same break-glass requireAccess gives it, so an owner can always
 * undo a restriction; a key (`forApiKey`) gets no break-glass and always loses
 * them. `abacRules` (member rules ++ assigned work-role policies ++ the org's
 * actionRestrictions) NARROW further, wherever requireAccess() evaluates them:
 * that is where a restriction WITH conditions applies. The resolved BigInt +
 * rules stay server-side; never serialize `permissions`.
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

/** The bits of every action an org's restrictions deny with no conditions. */
export function unconditionalDenyMask(rules: AbacRule[]): bigint {
  let mask = 0n;
  for (const rule of rules) {
    if (rule.effect !== "deny" || rule.conditions.length > 0) continue;
    for (const action of rule.actions) {
      const bit = (Permission as Record<string, bigint>)[action];
      if (typeof bit === "bigint") mask |= bit;
    }
  }
  return mask;
}

export async function loadEffectivePermissions(
  orgId: string,
  userId: string,
  opts: {
    /** The caller is an API key acting for this user: no OWNER break-glass. */
    forApiKey?: boolean;
  } = {},
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
      // The org's own deny rules (security settings), which apply to every
      // member and every key alike; an OWNER's session passes them (its
      // break-glass). See the note above on how they apply.
      org: { select: { securitySettings: { select: { actionRestrictions: true } } } },
    },
  });
  if (!member) return null;

  let grants = 0n;
  const workRolePolicies: AbacRule[] = [];
  for (const assignment of member.workRoles) {
    grants |= maskFromDb(assignment.workRole.grants);
    workRolePolicies.push(...coerceRules(assignment.workRole.policies));
  }

  const restrictions = coerceRules(member.org.securitySettings?.actionRestrictions);
  const breakGlass = member.role === "OWNER" && !opts.forApiKey;
  const removed = breakGlass ? 0n : unconditionalDenyMask(restrictions);

  const basePermissions = resolvePermissions(member.role, maskFromDb(member.permissions)) & ~removed;
  return {
    orgRole: member.role,
    permissions: (basePermissions | grants) & ~removed,
    basePermissions,
    abacRules: [...coerceRules(member.abacRules), ...workRolePolicies, ...restrictions],
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
