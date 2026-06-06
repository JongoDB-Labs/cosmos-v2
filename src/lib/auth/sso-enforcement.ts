import { prisma } from "@/lib/db/client";
import { isInternalAdmin } from "@/lib/internal/access";

/**
 * Gov SSO-enforcement guard for the Google (non-SSO) login path.
 *
 * The bypass this closes: a GOV tenant can mark its IdpConnection `enforced`
 * (SSO-only), but `enforced` was read NOWHERE on the Google callback — so a gov
 * member with a Google account could mint a session via Google and bypass the
 * IdP entirely (skipping the IdP-asserted MFA / AAL floor). This guard makes the
 * Google callback reject such a login.
 *
 * Scope of "belongs to a gov enforced org": the authenticating email is a MEMBER
 * of, or has a pending unexpired INVITATION to, any GOV-class org whose
 * IdpConnection is BOTH `enabled` AND `enforced`. Those users must come through
 * `/api/auth/sso/<slug>/login`, never Google.
 *
 * BREAK-GLASS: a platform owner on the `INTERNAL_ADMINS` allowlist is exempt.
 * This is the interim gov-lockout recovery path (IdP down + Google disabled) —
 * see HANDOFF.md "Break-glass" and SSP §3.5. The follow-on is a hardware-key-
 * gated local-OWNER login; until then INTERNAL_ADMINS is the documented escape.
 */
export async function googleLoginBlockedByGovSso(args: {
  email: string;
  userId: string | null;
}): Promise<boolean> {
  const { email, userId } = args;

  // Break-glass: platform owners are never locked out by a tenant's SSO policy.
  if (isInternalAdmin(email, process.env.INTERNAL_ADMINS)) {
    return false;
  }

  // A GOV org with an enabled+enforced IdpConnection that this identity belongs
  // to (member) or is invited to. One query per relation; either hit blocks.
  const govEnforcedFilter = {
    tenantClass: "GOV" as const,
    idpConnection: { is: { enabled: true, enforced: true } },
  };

  if (userId) {
    const member = await prisma.orgMember.findFirst({
      where: { userId, org: govEnforcedFilter },
      select: { id: true },
    });
    if (member) return true;
  }

  const invite = await prisma.invitation.findFirst({
    where: {
      email,
      expiresAt: { gt: new Date() },
      org: govEnforcedFilter,
    },
    select: { id: true },
  });
  if (invite) return true;

  return false;
}
