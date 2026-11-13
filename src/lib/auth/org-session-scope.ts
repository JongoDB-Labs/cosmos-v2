import { prisma } from "@/lib/db/client";
import { isSystemAdmin, type SystemAdminSubject } from "@/lib/internal/access";
import { orgRequiresSso } from "./sso-enforcement";

/**
 * Which organizations a session may open. The one rule both getAuthContext and
 * the organization picker read, so what the picker says matches what a page or
 * an API route will do.
 *
 *  - `sso_other_org`: the session came through an organization's single sign-on
 *    (or says it did without naming a connection). It opens that organization
 *    only. An org's IdP is trusted for its own org: a session it minted must not
 *    reach the account's other orgs, whatever role the account holds there.
 *  - `sso_required`: the org requires single sign-on, and this session did not
 *    come through the org's own IdP. A platform admin's own first-party session
 *    (one that vouches for their address, see lib/internal/access) is the
 *    break-glass, so a broken IdP cannot lock the operator out.
 */
export type OrgSessionRefusal = "sso_other_org" | "sso_required";

export type OrgSessionSubject = SystemAdminSubject;

export function isSsoSession(s: { authMethod: string | null; idpConnId: string | null }): boolean {
  return s.authMethod === "oidc" || s.idpConnId != null;
}

export async function orgSessionRefusal(
  user: OrgSessionSubject,
  org: { id: string; tenantClass: string },
): Promise<OrgSessionRefusal | null> {
  if (isSsoSession(user)) {
    if (!user.idpConnId) return "sso_other_org";
    const conn = await prisma.idpConnection.findUnique({
      where: { id: user.idpConnId },
      select: { orgId: true },
    });
    return conn?.orgId === org.id ? null : "sso_other_org";
  }
  if ((await orgRequiresSso(org)) && !isSystemAdmin(user)) return "sso_required";
  return null;
}

/** What the person is told, in the picker and anywhere else a refusal shows. */
export const ORG_SESSION_REFUSAL_TEXT: Record<OrgSessionRefusal, string> = {
  sso_other_org:
    "You signed in through another organization's single sign-on. Sign in another way to open this organization.",
  sso_required: "This organization requires single sign-on.",
};
