import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";

type ChannelLite = {
  kind: "CHANNEL" | "DM" | "GROUP_DM";
  isPrivate: boolean;
  isGeneral: boolean;
  orgId: string;
};
type ChannelMemberLite = { role: "ADMIN" | "MEMBER" };

/**
 * Visibility predicate. Returns true if the viewer can SEE (list, GET detail,
 * fetch messages from) the channel. Pure function — no DB.
 */
export function canSeeChannelGiven(args: {
  channel: ChannelLite;
  member: ChannelMemberLite | null;
  viewerOrgId: string;
  orgRole: OrgRole;
}): boolean {
  if (args.channel.orgId !== args.viewerOrgId) return false;
  // DM and GROUP_DM are members-only regardless of isPrivate
  if (args.channel.kind !== "CHANNEL") return !!args.member;
  // Public CHANNELs visible to everyone in the org
  if (!args.channel.isPrivate) return true;
  // Private CHANNELs visible to members only
  return !!args.member;
}

/**
 * Posting predicate. Membership required to post in any channel.
 */
export function canPostToChannelGiven(args: {
  channel: ChannelLite;
  member: ChannelMemberLite | null;
  viewerOrgId: string;
  orgRole: OrgRole;
}): boolean {
  if (args.channel.orgId !== args.viewerOrgId) return false;
  return !!args.member;
}

/**
 * Management predicate. Channel admin OR org OWNER/ADMIN can rename, archive,
 * add/remove members, promote/demote channel admins.
 */
export function canManageChannelGiven(args: {
  channel: ChannelLite;
  member: ChannelMemberLite | null;
  viewerOrgId: string;
  orgRole: OrgRole;
}): boolean {
  if (args.channel.orgId !== args.viewerOrgId) return false;
  if (args.orgRole === "OWNER" || args.orgRole === "ADMIN") return true;
  return args.member?.role === "ADMIN";
}

/**
 * Message-delete predicate. Authors can always delete their own messages.
 * Channel admins and org OWNER/ADMIN can delete any message.
 */
export function canDeleteMessageGiven(args: {
  authorId: string;
  viewerId: string;
  channelMember: ChannelMemberLite | null;
  orgRole: OrgRole;
}): boolean {
  if (args.authorId === args.viewerId) return true;
  if (args.orgRole === "OWNER" || args.orgRole === "ADMIN") return true;
  return args.channelMember?.role === "ADMIN";
}

/**
 * DB-aware convenience: fetch the channel + the viewer's membership in a
 * single round-trip. Caller threads the result into the predicates above.
 */
export async function loadChannelAndMembership(channelId: string, userId: string) {
  const [channel, member] = await Promise.all([
    prisma.chatChannel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        orgId: true,
        kind: true,
        isPrivate: true,
        isGeneral: true,
        archivedAt: true,
        name: true,
      },
    }),
    prisma.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: {
        id: true,
        role: true,
        notificationPref: true,
        lastReadMessageId: true,
        mutedUntil: true,
      },
    }),
  ]);
  return { channel, member };
}
