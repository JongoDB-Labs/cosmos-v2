import { prisma } from "@/lib/db/client";
import { createNotification } from "@/lib/notifications/create";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";

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
  const members = await prisma.chatChannelMember.findMany({
    where: { channelId: input.channelId },
    select: { userId: true, notificationPref: true, mutedUntil: true },
  });

  const now = new Date();
  const url = `/${input.orgSlug}/chat/${input.channelId}#msg-${input.messageId}`;
  const snippet = input.content.replace(/<@[0-9a-f-]{36}>/gi, "@user").slice(0, 200);
  const mentions = new Set(input.mentionedUserIds.map((id) => id.toLowerCase()));

  // Teams notification (FR 8a162fe7): one channel post per message that carries
  // @mentions — OFF by default (chat noise); gated + best-effort in teamsNotify.
  if (input.mentionedUserIds.length > 0) {
    void (async () => {
      const users = await prisma.user.findMany({
        where: { id: { in: input.mentionedUserIds } },
        select: { displayName: true },
      });
      const names = users.map((u) => escapeHtmlBasic(u.displayName)).join(", ");
      await teamsNotify(
        input.orgId,
        "mentions",
        `\u{1F4AC} <b>${escapeHtmlBasic(input.authorDisplayName)}</b> mentioned ${names} in chat: \u201C${escapeHtmlBasic(snippet)}\u201D`,
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
