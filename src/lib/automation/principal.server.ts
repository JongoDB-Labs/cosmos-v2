/**
 * Who an automation acts as (workflow P4, Q7 as approved).
 *
 * A rule's actions are checked against its OWNER's access, loaded fresh on
 * every run (so a role removed this morning is gone by the next run) and
 * capped at what the owner held when they last saved the rule (`actorCap`). It
 * can never do more than either. `isApiKey: true` keeps the OWNER break-glass
 * out of it, as for any credential that acts for a person without them there
 * (calendar sync does the same). An owner who is no longer a member gives no
 * context: the rule is switched off until someone takes it over by saving it.
 *
 * What the change log and activity show as the actor is the org's "Cosmos
 * Automation" user: a bot account (isBot, the chat bots' pattern) that is not
 * a member and holds no permissions of its own. It only names who did it.
 */
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { maskFromDb } from "@/lib/rbac/permissions";

/** Advisory-lock namespace for automation work (the others: 20202-20204). */
export const AUTOMATION_LOCK_NAMESPACE = 20205;

const automationEmail = (orgId: string) => `bot+automation@${orgId}.cosmos.local`;

/**
 * The org's automation user, created on first use. Idempotent: users.email
 * isn't unique, so the find-or-create runs under a per-org advisory lock and
 * two workers can't each create one.
 */
export async function automationUserId(orgId: string): Promise<string> {
  const email = automationEmail(orgId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTOMATION_LOCK_NAMESPACE}::int, hashtext(${`user:${orgId}`}))`;
    const existing = await tx.user.findFirst({ where: { email, isBot: true }, orderBy: { id: "asc" }, select: { id: true } });
    if (existing) return existing.id;
    return (await tx.user.create({ data: { email, displayName: "Cosmos Automation", isBot: true }, select: { id: true } })).id;
  });
}

/**
 * The context a rule's actions run under, or null when its owner can't act
 * for it (no owner, or no longer a member).
 */
export async function ruleContext(rule: { orgId: string; ownerId: string | null; actorCap: string }): Promise<AuthContext | null> {
  if (!rule.ownerId) return null;
  const member = await loadMemberAuthContext(rule.orgId, rule.ownerId);
  if (!member) return null;
  const cap = maskFromDb(rule.actorCap);
  return {
    ...member,
    permissions: member.permissions & cap,
    basePermissions: member.basePermissions & cap,
    isApiKey: true,
  };
}
