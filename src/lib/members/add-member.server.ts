import { OrgRole, Prisma } from "@prisma/client";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { endMemberCredentialsIn } from "@/lib/members/credentials.server";
import { escapeLike } from "@/lib/query/like";
import { HELD_WORK_ROLES, heldBeyondRole } from "@/lib/rbac/grant-ceiling";

/**
 * A person's membership row in an org, removed or not, with what it holds
 * beyond its role (for the grant ceiling).
 *
 * Unfiltered on purpose: removal is a soft delete, so a removed person still
 * HAS a row, and `@@unique([orgId, userId])` refuses a second one. The
 * default-filtered client reports them absent, and creating a membership on
 * that answer is a unique violation. Accepting an invitation did exactly that,
 * swallowed the error and deleted the invitation, so the person never got back
 * in and nobody was told.
 */
export function membershipRow(orgId: string, userId: string) {
  return prismaUnfiltered.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true, removedAt: true, permissions: true, workRoles: HELD_WORK_ROLES },
  });
}

export type MembershipRow = NonNullable<Awaited<ReturnType<typeof membershipRow>>>;

/** The removed memberships in this org held by an account at `email` (exact, ignoring case). */
export function removedMembershipsFor(orgId: string, email: string) {
  return prismaUnfiltered.orgMember.findMany({
    where: {
      orgId,
      removedAt: { not: null },
      user: { email: { equals: escapeLike(email), mode: "insensitive" } },
    },
    select: { removedAt: true, permissions: true, workRoles: HELD_WORK_ROLES },
  });
}

/**
 * What inviting `email` back hands out beyond the invitation's own role and
 * work roles: the stored override and work-role grants of a removed membership
 * in this org held by an account at that address. Accepting the invitation
 * reinstates that row (addOrReinstateMember), so these count as granted, as
 * they do when an admin re-adds the person from the members list.
 */
export async function retainedGrantsFor(orgId: string, email: string): Promise<bigint> {
  const rows = await removedMembershipsFor(orgId, email);
  return rows.reduce((acc, r) => acc | heldBeyondRole(r), 0n);
}

/**
 * Was an invitation issued at `issuedAt` sent before this membership was
 * removed? Such an invitation never brings the person back: its grant ceiling
 * ran before the removal, and the removal is the later decision. Removing a
 * member deletes their invitations, so this catches the ones that predate that
 * rule. Resending changes only the expiry, so it does not make one new; the
 * admin sends a new invitation instead.
 */
export function issuedBeforeRemoval(issuedAt: Date, row: { removedAt: Date | null } | null): boolean {
  return row?.removedAt != null && issuedAt.getTime() <= row.removedAt.getTime();
}

export const ISSUED_BEFORE_REMOVAL_MESSAGE =
  "This invitation was sent before they were removed, so it can't bring them back. Send them a new invitation.";

const MEMBER_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
  joinedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} as const;

export type AddedMember = Prisma.OrgMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Let a person into an org: reinstate their retained row when they were
 * removed, otherwise create one. Both doors that let someone in write through
 * this: an admin adding them (members POST) and the person accepting an
 * invitation (consumePendingInvitations).
 *
 * Reinstating brings back the SAME row, so their retained project memberships
 * and work roles come back with them, which is what the common case (a removal
 * being undone) calls for, and their history stays on one membership id. The
 * role is the one given now, so reinstating is never a silent re-grant of the
 * old one. Their API keys and calendar links are NOT among what comes back:
 * any left on the row are ended in the same transaction
 * (endMemberCredentialsIn), so neither outlives the removal it was made before.
 *
 * `existing` is their row from {@link membershipRow}. The caller runs the
 * grant ceiling over it first: what reinstating hands back counts as granted.
 * org-role-grant.arch.test.ts counts a call to this as an access write in the
 * calling function. Returns null, writing nothing, when they are already a
 * member: that row, or one a concurrent request created since it was read.
 */
export async function addOrReinstateMember(p: {
  orgId: string;
  userId: string;
  role: OrgRole;
  existing: MembershipRow | null;
  /** Who let them in: the admin, or the person accepting their own invitation. */
  actorUserId: string;
  ipAddress?: string;
  /** Recorded on the audit row beside the target and the role. */
  auditMetadata?: Record<string, string>;
}): Promise<{ member: AddedMember; reinstated: boolean } | null> {
  const { orgId, userId, role, existing } = p;
  if (existing && existing.removedAt === null) return null;

  let member: AddedMember;
  if (existing) {
    member = await prismaUnfiltered.$transaction(async (tx) => {
      const reinstated = await tx.orgMember.update({
        where: { id: existing.id },
        data: { removedAt: null, role },
        select: MEMBER_SELECT,
      });
      await endMemberCredentialsIn(tx, {
        orgId,
        userId,
        memberId: existing.id,
        actorUserId: p.actorUserId,
        reason: "reinstated",
        ipAddress: p.ipAddress,
      });
      return reinstated;
    });
  } else {
    try {
      member = await prisma.orgMember.create({ data: { orgId, userId, role }, select: MEMBER_SELECT });
    } catch (err) {
      // A concurrent request (a second sign-in tab, a double-clicked Add) made
      // the row after `existing` was read. A current membership means they are
      // in; anything else is not that race, and is not swallowed.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const now = await membershipRow(orgId, userId);
      if (now && now.removedAt === null) return null;
      throw err;
    }
  }

  await logAudit({
    orgId,
    userId: p.actorUserId,
    action: existing ? "member.reinstated" : "member.added",
    entity: "org_member",
    entityId: member.id,
    metadata: { ...p.auditMetadata, targetUserId: userId, role },
    ipAddress: p.ipAddress,
  });

  try {
    await autoJoinGeneral(orgId, userId, role === OrgRole.OWNER || role === OrgRole.ADMIN);
  } catch (err) {
    console.warn("[chat] failed to auto-join member to #general", { orgId, userId }, err);
  }

  return { member, reinstated: existing !== null };
}
