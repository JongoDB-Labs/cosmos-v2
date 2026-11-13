import { prisma } from "@/lib/db/client";

/**
 * Does this organization require single sign-on?
 *
 * A GOV-class org whose IdP connection is both `enabled` and `enforced`. It is
 * a property of the org, enforced where an org is opened (getAuthContext, via
 * lib/auth/org-session-scope), never at sign-in: Google, Microsoft and password
 * sign-in still work for the person, and their other orgs still open. Only this
 * org refuses a session that did not come through its own IdP.
 *
 * Break-glass (a platform admin's own first-party session) is decided by the
 * caller, from the session, in org-session-scope.
 */
export async function orgRequiresSso(org: { id: string; tenantClass: string }): Promise<boolean> {
  if (org.tenantClass !== "GOV") return false;
  const conn = await prisma.idpConnection.findUnique({
    where: { orgId: org.id },
    select: { enabled: true, enforced: true },
  });
  return Boolean(conn?.enabled && conn.enforced);
}
