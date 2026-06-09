import { prisma } from "@/lib/db/client";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { OrgRole } from "@prisma/client";

/**
 * Consume all pending, unexpired invitations addressed to `email`: create the
 * org membership, assign the work-roles chosen at invite time, auto-join
 * #general, then delete the invite. Shared by the Google + Microsoft sign-in
 * callbacks (previously duplicated, and without work-role assignment).
 *
 * Best-effort per invite — a race ("already a member") or a since-deleted
 * work-role is skipped, never fatal to the sign-in.
 */
export async function consumePendingInvitations(
  userId: string,
  email: string,
): Promise<void> {
  const pending = await prisma.invitation.findMany({
    where: { email, expiresAt: { gt: new Date() } },
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

    const newMember = await prisma.orgMember
      .create({
        data: { orgId: invite.orgId, userId, role: invite.role },
      })
      .catch(() => undefined); // race: already a member is fine

    if (newMember) {
      // Apply the work-roles selected at invite time — only those that still
      // exist in this org (a role may have been deleted since the invite).
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
                orgMemberId: newMember.id,
                workRoleId: r.id,
              })),
              skipDuplicates: true,
            })
            .catch(() => undefined);
        }
      }

      try {
        await autoJoinGeneral(
          newMember.orgId,
          newMember.userId,
          newMember.role === OrgRole.OWNER || newMember.role === OrgRole.ADMIN,
        );
      } catch (err) {
        console.warn(
          "[chat] failed to auto-join invited member to #general",
          { orgId: newMember.orgId, userId },
          err,
        );
      }
    }

    await prisma.invitation.delete({ where: { id: invite.id } }).catch(() => undefined);
  }
}
