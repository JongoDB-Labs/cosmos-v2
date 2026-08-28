import type { Prisma } from "@prisma/client";

/**
 * Undo the account an email/password invitation provisioned, when revoking it.
 *
 * WHY: creating an email/password invite for a brand-new address also creates a
 * User with an admin-set temp password. Revoking deleted only the invitation, so
 * the account survived — and the NEXT invite to that address then took the
 * "pre-existing account" branch, which deliberately never attaches an
 * admin-generated credential. The invitee got an OAuth-style invite with no
 * password, for an account whose only password was the one just revoked. A dead
 * end that looked like a working re-invite.
 *
 * This is a DELETE, so the guards are the whole design. We remove the account
 * only when it is unambiguously an artifact of the invitation being revoked:
 *
 *   - the invitation provisioned it        (signInMethod === "email_password")
 *   - it belongs to no organisation        (never accepted anywhere)
 *   - it has never been used               (lastActiveAt null)
 *   - its password is still the issued one (mustChangePassword still true)
 *   - no external identity is linked       (no googleId / auth0UserId)
 *   - no OTHER invitation is pending       (another org may be relying on it)
 *
 * Any one of those failing means a real person may be behind the account, and we
 * leave it alone. Revoking is then exactly what it was before: the invitation
 * goes, the account stays.
 */
export async function revokeProvisionedAccount(
  tx: Prisma.TransactionClient,
  params: { email: string; invitationId: string; signInMethod: string },
): Promise<{ deleted: boolean; reason: string }> {
  if (params.signInMethod !== "email_password") {
    return { deleted: false, reason: "invitation did not provision an account" };
  }

  const user = await tx.user.findFirst({
    where: { email: { equals: params.email, mode: "insensitive" } },
    select: {
      id: true,
      lastActiveAt: true,
      mustChangePassword: true,
      googleId: true,
      auth0UserId: true,
      _count: { select: { memberships: true } },
    },
  });
  if (!user) return { deleted: false, reason: "no account for this address" };

  if (user._count.memberships > 0) return { deleted: false, reason: "account belongs to an organisation" };
  if (user.lastActiveAt !== null) return { deleted: false, reason: "account has been used" };
  if (!user.mustChangePassword) return { deleted: false, reason: "account has its own password" };
  if (user.googleId || user.auth0UserId) return { deleted: false, reason: "account has a linked identity" };

  // Another org's pending invite would be relying on this account existing.
  const otherPending = await tx.invitation.count({
    where: {
      email: { equals: params.email, mode: "insensitive" },
      id: { not: params.invitationId },
    },
  });
  if (otherPending > 0) return { deleted: false, reason: "another invitation is pending" };

  await tx.user.delete({ where: { id: user.id } });
  return { deleted: true, reason: "unused provisioned account removed" };
}
