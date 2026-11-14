import { prisma } from "@/lib/db/client";
import { createNotification } from "@/lib/notifications/create";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { channelPolicy } from "@/lib/integrations/channel-policy.server";
import { mentionsToPlainText, userMentionLabels } from "@/lib/mentions/plain-text";
import { chatDrawerHref } from "@/lib/chat/drawer-link";
import { channelProjectReaders } from "@/lib/chat/access";

export interface FanOutInput {
  /** Org id of the channel (used by createNotification + audit). */
  orgId: string;
  /** Channel the message landed in. */
  channelId: string;
  channelKind: "CHANNEL" | "DM" | "GROUP_DM";
  /** Channel name for the notification title; null for DM/GROUP_DM (use author name). */
  channelName: string | null;
  /** Org slug for click-through URL synthesis. */
  orgSlug: string;
  messageId: string;
  authorId: string;
  authorDisplayName: string;
  /** Full message content (used for snippet preview). */
  content: string;
  /** UUIDs already validated as org-member-matching mentions in this message. */
  mentionedUserIds: string[];
}

/**
 * Fan a freshly-sent chat message out to channel members:
 *   - Always emit `chat.unread.bumped` on each member's user topic so badges
 *     update in real time (regardless of notification pref).
 *   - Write a Notification row + push for members based on notificationPref:
 *       MUTED              → nothing
 *       MENTIONS (default) → notification only if the member was @mentioned
 *       ALL                → notification on every message
 *       DM kind            → notification regardless of pref (unless MUTED)
 *
 * Always skips the author. Best-effort: per-recipient errors are swallowed so
 * one bad recipient doesn't block fan-out to peers.
 */
export async function fanOutChatMessage(input: FanOutInput): Promise<void> {
  const [rows, channel] = await Promise.all([
    prisma.chatChannelMember.findMany({
      where: { channelId: input.channelId },
      select: { userId: true, notificationPref: true, mutedUntil: true },
    }),
    prisma.chatChannel.findUnique({ where: { id: input.channelId }, select: { projectId: true } }),
  ]);
  // A notification quotes the message, so it goes only to members who may still
  // read the channel: one under a project they can't see is not theirs to read
  // (lib/chat/access.ts), however long they have been in it.
  const readers = await channelProjectReaders(input.orgId, channel?.projectId ?? null, rows.map((m) => m.userId));
  const members = rows.filter((m) => readers.has(m.userId));

  const now = new Date();
  // Opens the Chat drawer at the message. A stored link has no page to stand
  // on, so it is the org home; the bell and the inbox open the drawer beside
  // whatever page you are on instead (chatDrawerTargetFromUrl).
  const url = chatDrawerHref(`/${input.orgSlug}`, {
    channelId: input.channelId,
    messageId: input.messageId,
  });

  // Resolve the mentioned people ONCE. The snippet below and the Teams card
  // both need their names, and the Teams block used to run its own identical
  // query — so this is one round trip where there were two, and the snippet
  // now names who was addressed instead of saying "@user".
  const mentionedUsers = input.mentionedUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: input.mentionedUserIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const snippet = mentionsToPlainText(
    input.content,
    userMentionLabels(mentionedUsers),
  ).slice(0, 200);
  const mentions = new Set(input.mentionedUserIds.map((id) => id.toLowerCase()));

  // Teams notification (FR 8a162fe7): one channel post per message that carries
  // @mentions — OFF by default (chat noise); gated + best-effort in teamsNotify.
  // Only from a public channel: the Teams channel is read org-wide, so a
  // private channel's or a direct message's words never go there.
  if (input.mentionedUserIds.length > 0 && input.channelKind === "CHANNEL") {
    void (async () => {
      const policy = await channelPolicy(input.orgId);
      const channel = await policy.chatChannel(input.channelId);
      if (!channel) return;
      const quoted = policy.text(channel.projectId, snippet);
      const names = mentionedUsers.map((u) => escapeHtmlBasic(u.displayName)).join(", ");
      await teamsNotify(
        input.orgId,
        "mentions",
        `\u{1F4AC} <b>${escapeHtmlBasic(input.authorDisplayName)}</b> mentioned ${names} in chat${quoted ? `: \u201C${escapeHtmlBasic(quoted)}\u201D` : ""}`,
        { chatChannelId: input.channelId },
      );
    })().catch(() => {});
  }

  for (const m of members) {
    if (m.userId === input.authorId) continue;

    // Unread badge bump for every non-author member, unconditional.
    void getBus().publish(topics.user(m.userId), "chat.unread.bumped", {
      channelId: input.channelId,
    });

    const muted =
      m.notificationPref === "MUTED" ||
      (m.mutedUntil !== null && m.mutedUntil > now);
    if (muted) continue;

    let type: "chat.mentioned" | "chat.dm" | "chat.message" | null = null;
    let title: string;

    if (input.channelKind === "DM" || input.channelKind === "GROUP_DM") {
      type = "chat.dm";
      title = `New message from ${input.authorDisplayName}`;
    } else if (mentions.has(m.userId.toLowerCase())) {
      type = "chat.mentioned";
      title = `${input.authorDisplayName} mentioned you in #${input.channelName ?? "chat"}`;
    } else if (m.notificationPref === "ALL") {
      type = "chat.message";
      title = `${input.authorDisplayName} posted in #${input.channelName ?? "chat"}`;
    } else {
      // MENTIONS pref but the user wasn't mentioned — no notification.
      continue;
    }

    try {
      await createNotification({
        orgId: input.orgId,
        userId: m.userId,
        type,
        title,
        message: snippet,
        relatedId: input.messageId,
        relatedType: "chat_message",
        url,
      });
    } catch (err) {
      console.warn("[chat] failed to fan-out notification", { userId: m.userId, type }, err);
    }
  }
}
