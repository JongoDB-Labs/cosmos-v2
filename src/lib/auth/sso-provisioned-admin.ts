import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";

/**
 * Instance admin tools for `User.ssoProvisioned` ("an organization's IdP made
 * this account"). The flag keeps an account out of platform admin and keeps
 * Google and Microsoft from linking to it by email. The migration that added it
 * flagged older accounts conservatively, by evidence; when it flagged an
 * account its owner really made, an instance admin clears it here.
 */

export type SsoProvisionedAccount = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  orgs: string[];
};

export async function listSsoProvisioned(): Promise<SsoProvisionedAccount[]> {
  const rows = await prisma.user.findMany({
    where: { ssoProvisioned: true, isBot: false },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      email: true,
      displayName: true,
      createdAt: true,
      memberships: { select: { org: { select: { name: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    createdAt: r.createdAt.toISOString(),
    orgs: r.memberships.map((m) => m.org.name),
  }));
}

/** The orgs whose audit log should show a change to this account: every org it
 *  belongs to (removed memberships too) and every org whose IdP it is bound to. */
async function auditOrgsFor(userId: string): Promise<string[]> {
  const [members, bindings] = await Promise.all([
    prismaUnfiltered.orgMember.findMany({ where: { userId }, select: { orgId: true } }),
    prisma.federatedIdentity.findMany({ where: { userId }, select: { idpConn: { select: { orgId: true } } } }),
  ]);
  return [...new Set([...members.map((m) => m.orgId), ...bindings.map((b) => b.idpConn.orgId)])];
}

/**
 * Clear the flag on one account, and say so in the audit log of every org the
 * account is tied to. The server log records it too, since an account tied to
 * no org has no audit log to write to. Returns false when there was nothing to
 * clear.
 */
export async function clearSsoProvisioned(actorUserId: string, targetUserId: string): Promise<boolean> {
  const cleared = await prisma.user.updateMany({
    where: { id: targetUserId, ssoProvisioned: true },
    data: { ssoProvisioned: false },
  });
  if (cleared.count === 0) return false;
  const orgIds = await auditOrgsFor(targetUserId);
  console.info(
    `[auth] instance admin ${actorUserId} cleared the IdP-made flag on user ${targetUserId} (audited in ${orgIds.length} org(s))`,
  );
  for (const orgId of orgIds) {
    await logAudit({
      orgId,
      userId: actorUserId,
      action: "auth.sso_provisioned.cleared",
      entity: "user",
      entityId: targetUserId,
    });
  }
  return true;
}
