import { OrgRole, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { hiddenProjectIds, isProjectVisible } from "@/lib/rbac/project-access";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";

/**
 * Chat, read or write, needs CHAT_USE: the bit the Chat page itself is gated
 * on. A VIEWER or GUEST session does not hold it, and no API key scope grants
 * it, so no key reads or writes chat. Every handler under `/chat` checks it
 * (`chat-use-gate.arch.test.ts`).
 */
export function mayUseChat(ctx: Pick<AuthContext, "permissions">): boolean {
  return hasPermission(ctx.permissions, Permission.CHAT_USE);
}

type ChannelLite = {
  kind: "CHANNEL" | "DM" | "GROUP_DM";
  isPrivate: boolean;
  isGeneral: boolean;
  orgId: string;
  /**
   * Whether the viewer may see the project this channel belongs to, and true
   * when it belongs to none: `channelProjectVisible`, which
   * `loadChannelAndMembership` and `visibleChannelProjectIds` apply for you.
   * Required, so a channel read some other way can't reach a predicate without
   * having been asked.
   */
  projectVisible: boolean;
};
type ChannelMemberLite = { role: "ADMIN" | "MEMBER" };

/**
 * A channel tied to a project is that project's conversation, so it is as
 * visible as the project: to a member of a team-scoped project, or an org
 * owner or admin, and to nobody else, whatever the channel's own rules say.
 * Joining the channel, or having joined it before the project was limited or
 * before leaving its team, doesn't count: a member who loses the project loses
 * the channel (it leaves their list, and reading and posting are refused) until
 * they can see the project again.
 *
 * `isProjectVisible`, the rule the project routes use, so the two can't
 * disagree. A project that no longer exists is visible to nobody, so the
 * channel of a deleted project is hidden rather than opened to the whole org.
 */
export async function channelProjectVisible(ctx: AuthContext, projectId: string | null | undefined): Promise<boolean> {
  return !projectId || isProjectVisible(ctx, projectId);
}

/**
 * `channelProjectVisible` in set form, for lists and raw SQL: the org's
 * projects whose channels the actor may see. Every project in the org but the
 * ones `hiddenProjectIds` names, which is `isProjectVisible`'s rule over the
 * org; a project that no longer exists is in neither list, so its channels stay
 * hidden here as they are by id.
 */
export async function visibleChannelProjectIds(ctx: AuthContext): Promise<string[]> {
  const [projects, hidden] = await Promise.all([
    prisma.project.findMany({ where: { orgId: ctx.orgId }, select: { id: true } }),
    hiddenProjectIds(ctx),
  ]);
  const hide = new Set(hidden);
  return projects.map((p) => p.id).filter((id) => !hide.has(id));
}

/** A `where` for channel lists: channels under no project, or under one the actor can see. */
export async function visibleChannelWhere(ctx: AuthContext): Promise<Prisma.ChatChannelWhereInput> {
  return { OR: [{ projectId: null }, { projectId: { in: await visibleChannelProjectIds(ctx) } }] };
}

/**
 * Of `userIds`, who may see a channel under `projectId`: the people a message
 * there may notify. `channelProjectVisible` judged as each of them, from their
 * own stored access (as createNotification judges a recipient), so someone no
 * longer in the org is no one's reader either.
 */
export async function channelProjectReaders(
  orgId: string,
  projectId: string | null,
  userIds: string[],
): Promise<Set<string>> {
  if (!projectId) return new Set(userIds);
  const sees = await Promise.all(
    userIds.map(async (userId) => {
      const ctx = await loadMemberAuthContext(orgId, userId);
      return !!ctx && (await channelProjectVisible(ctx, projectId));
    }),
  );
  return new Set(userIds.filter((_, i) => sees[i]));
}

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
  if (!args.channel.projectVisible) return false;
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
  if (!args.channel.projectVisible) return false;
  return !!args.member;
}

/**
 * Management predicate. Channel admin OR org OWNER/ADMIN can rename, archive,
 * add/remove members, promote/demote channel admins.
 *
 * Both are roles, so `roleCounts` must say whether this actor's roles count:
 * always for a browser session, never for an API key whose scopes don't grant
 * CHAT_USE (`roleCountsFor(ctx, Permission.CHAT_USE)`, lib/rbac/key-role.ts).
 * Whoever creates a channel is its ADMIN, so a key its creator minted would
 * otherwise administer it whatever the key's scopes.
 */
export function canManageChannelGiven(args: {
  channel: ChannelLite;
  member: ChannelMemberLite | null;
  viewerOrgId: string;
  orgRole: OrgRole;
  roleCounts: boolean;
}): boolean {
  if (args.channel.orgId !== args.viewerOrgId) return false;
  if (!args.channel.projectVisible) return false;
  if (!args.roleCounts) return false;
  if (args.orgRole === "OWNER" || args.orgRole === "ADMIN") return true;
  return args.member?.role === "ADMIN";
}

/**
 * Message-delete predicate. Authors can always delete their own messages.
 * Channel admins and org OWNER/ADMIN can delete any message, when their roles
 * count (`roleCounts`).
 */
export function canDeleteMessageGiven(args: {
  authorId: string;
  viewerId: string;
  channel: Pick<ChannelLite, "projectVisible">;
  channelMember: ChannelMemberLite | null;
  orgRole: OrgRole;
  /** Whether the actor's roles count; see canManageChannelGiven. */
  roleCounts: boolean;
}): boolean {
  if (!args.channel.projectVisible) return false;
  if (args.authorId === args.viewerId) return true;
  if (!args.roleCounts) return false;
  if (args.orgRole === "OWNER" || args.orgRole === "ADMIN") return true;
  return args.channelMember?.role === "ADMIN";
}

/**
 * DB-aware convenience: fetch the channel + the viewer's membership in a
 * single round-trip. Caller threads the result into the predicates above.
 *
 * A channel under a project the viewer can't see comes back as no channel at
 * all (`channelProjectVisible`), so every route answers it as it answers a
 * missing one: whether it exists is not theirs to learn either.
 */
export async function loadChannelAndMembership(ctx: AuthContext, channelId: string) {
  const userId = ctx.userId;
  const [row, member] = await Promise.all([
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
        projectId: true,
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
  if (!row || !(await channelProjectVisible(ctx, row.projectId))) return { channel: null, member: null };
  return { channel: { ...row, projectVisible: true }, member };
}
