import { prisma } from "@/lib/db/client";

/** The rule itself: a GOV-class org whose IdP connection is both `enabled` and `enforced`. */
function enforces(tenantClass: string, conn: { enabled: boolean; enforced: boolean } | null): boolean {
  return tenantClass === "GOV" && Boolean(conn?.enabled && conn.enforced);
}

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
  return enforces(org.tenantClass, conn);
}

/**
 * The IdP connection this org requires sign-in through, by id, or null when it
 * requires none: the same rule as `orgRequiresSso`. An API key reads it, since
 * a key has no session of its own: a key made by someone who can't manage keys
 * works here only if it was made from a session of this connection
 * (lib/auth/api-key-policy.ts `keyInactiveReason`).
 */
export async function requiredIdpConnectionId(orgId: string): Promise<string | null> {
  const conn = await prisma.idpConnection.findUnique({
    where: { orgId },
    select: { id: true, enabled: true, enforced: true, org: { select: { tenantClass: true } } },
  });
  return conn && enforces(conn.org.tenantClass, conn) ? conn.id : null;
}
