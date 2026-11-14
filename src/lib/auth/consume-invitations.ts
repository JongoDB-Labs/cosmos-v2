import { prisma } from "@/lib/db/client";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { escapeLike } from "@/lib/query/like";
import { addOrReinstateMember, membershipRow } from "@/lib/members/add-member.server";

/**
 * Consume all pending, unexpired invitations addressed to `email`: let the
 * person in (someone removed gets their own membership back, as when an admin
 * re-adds them), assign the work-roles chosen at invite time, then delete the
 * invite. Shared by the Google, Microsoft and password sign-ins.
 *
 * `email` matches an invitation's exact address, ignoring case: the OAuth
 * sign-ins pass the account's stored address, which may carry capitals.
 *
 * Best-effort per invite: someone who is already a member just has the invite
 * cleared, and a since-deleted work-role is skipped. Any other failure is
 * logged and leaves the invitation for their next sign-in; it never fails the
 * sign-in.
 */
export async function consumePendingInvitations(
  userId: string,
  email: string,
): Promise<void> {
  const pending = await prisma.invitation.findMany({
    where: { email: { equals: escapeLike(email), mode: "insensitive" }, expiresAt: { gt: new Date() } },
  });

  for (const invite of pending) {
    // Re-check the org's allowed-domains at acceptance (defense in depth: the
    // domain list may have tightened since the invite was created). If the
    // email's domain is no longer allowed, drop the stale invite without
    // granting membership.
    const sec = await prisma.orgSecuritySettings.findUnique({
      where: { orgId: invite.orgId },
      select: { allowedDomains: true },
    });
    if (!emailDomainAllowed(email, sec?.allowedDomains)) {
      await prisma.invitation.delete({ where: { id: invite.id } }).catch(() => undefined);
      continue;
    }

    // The grant ceiling ran when the invitation was created or resent, counting
    // what reinstating a removed membership hands back (retainedGrantsFor).
    let joined: Awaited<ReturnType<typeof addOrReinstateMember>>;
    try {
      joined = await addOrReinstateMember({
        orgId: invite.orgId,
        userId,
        role: invite.role,
        existing: await membershipRow(invite.orgId, userId),
        actorUserId: userId,
        auditMetadata: { invitationId: invite.id },
      });
    } catch (err) {
      console.error(
        "[invitations] could not accept an invitation; it stays for the next sign-in",
        { orgId: invite.orgId, invitationId: invite.id, userId },
        err,
      );
      continue;
    }

    if (joined) {
      // Apply the work-roles selected at invite time — only those that still
      // exist in this org (a role may have been deleted since the invite).
      const memberId = joined.member.id;
      const wrIds = Array.isArray(invite.workRoleIds) ? invite.workRoleIds : [];
      if (wrIds.length > 0) {
        const validRoles = await prisma.workRole.findMany({
          where: { id: { in: wrIds }, orgId: invite.orgId },
          select: { id: true },
        });
        if (validRoles.length > 0) {
          await prisma.orgMemberWorkRole
            .createMany({
              data: validRoles.map((r) => ({
                orgMemberId: memberId,
                workRoleId: r.id,
              })),
              skipDuplicates: true,
            })
            .catch(() => undefined);
        }
      }
    }

    await prisma.invitation.delete({ where: { id: invite.id } }).catch(() => undefined);
  }
}
