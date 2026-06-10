"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { useChatChannels } from "@/hooks/use-chat-channels";
import {
  useChatMessages,
  type ChatMessageDto,
} from "@/hooks/use-chat-messages";
import { useOrgMembers } from "./mention-picker";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
import { ChannelHeader } from "./channel-header";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { ThreadPane } from "./thread-pane";
import { useChatTyping } from "@/hooks/use-chat-typing";
import { TypingIndicator } from "./typing-indicator";
import { useChatReadState } from "@/hooks/use-chat-read-state";
import { usePinnedMessages } from "@/hooks/use-pinned-messages";
import { PinnedPanel } from "./pinned-panel";
import { COMMANDS } from "@/lib/chat/commands";

export function ChannelView({
  orgId,
  channelId,
  userId,
}: {
  orgId: string;
  channelId: string;
  userId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";

  const qc = useQueryClient();
  const msgsKey = useOrgQueryKey("chat-messages", channelId);
  const channelsKey = useOrgQueryKey("chat-channels");
  const { data: channels } = useChatChannels(orgId);
  const { data: messages } = useChatMessages(orgId, channelId);
  const { data: members } = useOrgMembers(orgId);
  const channel = channels?.find((c) => c.id === channelId);

  const usersById = useMemo(() => {
    const m = new Map<string, { displayName: string; avatarUrl: string | null }>();
    (members ?? []).forEach((u) =>
      m.set(u.id, { displayName: u.displayName, avatarUrl: u.avatarUrl }),
    );
    return m;
  }, [members]);

  const [threadParent, setThreadParent] = useState<ChatMessageDto | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);

  const { pins, pinnedIds } = usePinnedMessages(orgId, channelId);

  const { typingUserIds, feedTypingEvent, emitTyping } = useChatTyping(orgId, channelId, userId);
  const { readState, applyReceipt } = useChatReadState(orgId, channelId);

  useRealtimeEvents(orgId, {
    "chat.message.created": (data: unknown) => {
      const raw = data as Partial<ChatMessageDto> & { __overflow?: boolean };
      // Oversized bus payloads (>~6KB) arrive as a ref-only `{__overflow:true}`
      // marker (pg NOTIFY 8KB cap) — refetch the channel to pull the real row
      // instead of dropping it. Matters for long messages / long AI answers.
      if (raw.__overflow) {
        void qc.invalidateQueries({ queryKey: msgsKey });
        return;
      }
      if (raw.channelId !== channelId) return;
      // If this is a reply, increment the parent's replyCount in the main
      // feed cache and skip adding it to the feed itself.
      if (raw.parentMessageId != null) {
        qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
          prev?.map((m) =>
            m.id === raw.parentMessageId
              ? { ...m, replyCount: m.replyCount + 1 }
              : m,
          ) ?? [],
        );
        return;
      }
      // Normalize the bus payload — older publishers don't include
      // editedAt/deletedAt, and `MessageItem` tombstones any message whose
      // deletedAt is not strictly null (a missing field is undefined, which
      // !== null, so the new message would render as "[message deleted]").
      const d: ChatMessageDto = {
        id: raw.id!,
        channelId: raw.channelId!,
        authorId: raw.authorId!,
        content: raw.content ?? "",
        kind: raw.kind ?? "USER",
        parentMessageId: raw.parentMessageId ?? null,
        editedAt: raw.editedAt ?? null,
        deletedAt: raw.deletedAt ?? null,
        createdAt: raw.createdAt!,
        reactions: raw.reactions ?? [],
        attachments: raw.attachments ?? [],
        replyCount: raw.replyCount ?? 0,
      };
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) => {
        if (!prev) return [d];
        if (prev.some((m) => m.id === d.id)) return prev;
        return [...prev, d];
      });
    },
    "chat.message.updated": (data: unknown) => {
      const d = data as Pick<ChatMessageDto, "id" | "channelId" | "content" | "editedAt"> & { __overflow?: boolean };
      // A long final AI answer (or a long edit) overflows the bus payload cap;
      // refetch so the finished content shows live instead of stalling on the
      // last streamed ~6KB until reload.
      if (d.__overflow) {
        void qc.invalidateQueries({ queryKey: msgsKey });
        return;
      }
      if (d.channelId !== channelId) return;
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
        prev?.map((m) =>
          m.id === d.id
            ? { ...m, content: d.content, editedAt: d.editedAt }
            : m,
        ) ?? [],
      );
    },
    // In-progress AI answer: replace the streaming message's content with the
    // running text. The placeholder ASSISTANT bubble normally already exists
    // (its `chat.message.created` fires first), but tolerate races / late joins
    // by synthesizing a transient ASSISTANT bubble if it isn't in cache yet.
    // The final text arrives via `chat.message.updated` once the run completes.
    "chat.message.streaming": (data: unknown) => {
      const d = data as { channelId: string; messageId: string; content: string };
      if (d.channelId !== channelId) return;
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) => {
        const list = prev ?? [];
        const existing = list.find((m) => m.id === d.messageId);
        if (existing) {
          return list.map((m) =>
            m.id === d.messageId ? { ...m, content: d.content } : m,
          );
        }
        const transient: ChatMessageDto = {
          id: d.messageId,
          channelId,
          authorId: "",
          content: d.content,
          kind: "ASSISTANT",
          parentMessageId: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          reactions: [],
          attachments: [],
          replyCount: 0,
        };
        return [...list, transient];
      });
    },
    "chat.message.deleted": (data: unknown) => {
      const d = data as Pick<ChatMessageDto, "id" | "channelId">;
      if (d.channelId !== channelId) return;
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
        prev?.map((m) =>
          m.id === d.id
            ? {
                ...m,
                deletedAt: new Date().toISOString(),
                content: "",
              }
            : m,
        ) ?? [],
      );
    },
    "chat.reaction.added": (data: unknown) => {
      const d = data as { messageId: string; userId: string; emoji: string };
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
        prev?.map((m) =>
          m.id === d.messageId
            ? { ...m, reactions: [...m.reactions, { userId: d.userId, emoji: d.emoji }] }
            : m,
        ) ?? [],
      );
    },
    "chat.reaction.removed": (data: unknown) => {
      const d = data as { messageId: string; userId: string; emoji: string };
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
        prev?.map((m) =>
          m.id === d.messageId
            ? {
                ...m,
                reactions: m.reactions.filter(
                  (r) => !(r.userId === d.userId && r.emoji === d.emoji),
                ),
              }
            : m,
        ) ?? [],
      );
    },
    "chat.channel.joined": () => {
      qc.invalidateQueries({ queryKey: channelsKey });
    },
    "chat.channel.left": () => {
      qc.invalidateQueries({ queryKey: channelsKey });
    },
    "chat.typing": (data: unknown) => {
      feedTypingEvent(data as { userId: string; channelId: string; expiresAt: number });
    },
    "chat.read.receipt": (data: unknown) => {
      const d = data as { channelId: string; userId: string; lastReadMessageId: string };
      if (d.channelId !== channelId) return;
      applyReceipt(d.userId, d.lastReadMessageId);
    },
  });

  // Mark-read when the latest message id changes
  const lastMessageId = messages?.[messages.length - 1]?.id;
  useEffect(() => {
    if (!lastMessageId) return;
    fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: lastMessageId }),
    }).catch(() => {
      /* swallow */
    });
  }, [orgId, channelId, lastMessageId]);

  async function send(content: string, attachmentIds: string[], kind?: "USER" | "ACTION") {
    const optimistic: ChatMessageDto = {
      id: crypto.randomUUID(),
      channelId,
      authorId: userId,
      content,
      kind: kind ?? "USER",
      parentMessageId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      reactions: [],
      attachments: [],
      replyCount: 0,
    };
    qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) => [
      ...(prev ?? []),
      optimistic,
    ]);
    try {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: optimistic.id,
            content,
            attachmentIds,
            ...(kind ? { kind } : {}),
          }),
        },
      );
      if (!r.ok) {
        qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
          (prev ?? []).filter((m) => m.id !== optimistic.id),
        );
        notifyError(new Error("Message failed to send."), "Message failed to send.");
      }
    } catch (err) {
      qc.setQueryData<ChatMessageDto[]>(msgsKey, (prev) =>
        (prev ?? []).filter((m) => m.id !== optimistic.id),
      );
      notifyError(err, "Message failed to send.");
    }
  }

  async function react(messageId: string, emoji: string, isOwn: boolean) {
    try {
      if (isOwn) {
        const r = await fetch(
          `/api/v1/orgs/${orgId}/chat/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
          { method: "DELETE" },
        );
        if (!r.ok) throw new Error("Couldn't remove the reaction.");
      } else {
        const r = await fetch(`/api/v1/orgs/${orgId}/chat/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        if (!r.ok) throw new Error("Couldn't add the reaction.");
      }
    } catch (err) {
      notifyError(err, "Couldn't update the reaction.");
    }
  }

  async function edit(id: string, content: string) {
    const next = content.trim();
    if (!next) return;
    try {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/messages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      if (!r.ok) throw new Error("Couldn't edit the message.");
    } catch (err) {
      notifyError(err, "Couldn't edit the message.");
    }
  }

  async function del(id: string) {
    try {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/messages/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("Couldn't delete the message.");
    } catch (err) {
      notifyError(err, "Couldn't delete the message.");
    }
  }

  async function togglePin(messageId: string, isPinned: boolean) {
    try {
      if (isPinned) {
        const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/pins/${messageId}`, { method: "DELETE" });
        if (!r.ok) throw new Error("Couldn't unpin the message.");
      } else {
        const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/pins`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        if (r.status === 409) {
          toast.error("This channel has reached the 50-pin limit.");
          return;
        }
        if (!r.ok) throw new Error("Couldn't pin the message.");
      }
    } catch (err) {
      notifyError(err, "Couldn't update the pin.");
    }
  }

  async function sendReply(parentId: string, content: string) {
    const id = crypto.randomUUID();
    try {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, content, parentMessageId: parentId }),
      });
      if (!r.ok) throw new Error("Couldn't send the reply.");
    } catch (err) {
      notifyError(err, "Couldn't send the reply.");
    }
  }

  function commandErrorMessage(code?: string): string {
    switch (code) {
      case "forbidden": return "You don't have permission to do that here.";
      case "cannot_leave_general": return "You can't leave #general.";
      case "cannot_leave_dm": return "You can't leave a direct message.";
      case "no_user": return "Mention a user, e.g. /invite @name.";
      case "user_not_in_org": return "That user isn't in this org.";
      case "empty_prompt": return "Add a prompt, e.g. /ai summarize this.";
      default: return "Command failed.";
    }
  }

  async function runCommand(command: string, args: string) {
    const r = await fetch(
      `/api/v1/orgs/${orgId}/chat/channels/${channelId}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string };
      toast.error(commandErrorMessage(j.error));
      return;
    }
    const j = await r.json().catch(() => ({})) as { toast?: string; left?: boolean };
    if (j.toast) toast.success(j.toast);
    if (j.left) router.push(`/${orgSlug}/chat`);
  }

  async function runDm(mentionText: string) {
    const q = mentionText.replace(/^@/, "").trim().toLowerCase();
    if (!q) { toast.error("Mention a user, e.g. /dm @name."); return; }
    const u = (members ?? []).find(
      (m) =>
        m.displayName.toLowerCase() === q ||
        m.email.toLowerCase().startsWith(q),
    );
    if (!u) {
      toast.error("User not found.");
      return;
    }
    const r = await fetch(`/api/v1/orgs/${orgId}/chat/dms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds: [u.id] }),
    });
    if (!r.ok) {
      toast.error("Could not open DM.");
      return;
    }
    const j = await r.json() as { channelId?: string; data?: { channelId?: string } };
    const cid = j.channelId ?? j.data?.channelId;
    if (cid) router.push(`/${orgSlug}/chat/${cid}`);
  }

  if (!channel) {
    return (
      <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
        Channel not found
      </div>
    );
  }

  const label =
    channel.kind === "CHANNEL"
      ? channel.name ?? channel.id.slice(0, 6)
      : channel.otherParticipants.map((p) => p.displayName).join(", ") || "DM";

  return (
    <div className="flex flex-1 min-w-0">
      <section className="flex-1 flex flex-col min-w-0 relative">
        <ChannelHeader
          channel={channel}
          pinCount={pins.length}
          onTogglePins={() => setPinsOpen((v) => !v)}
        />
        {pinsOpen && (
          <PinnedPanel
            pins={pins}
            usersById={usersById}
            onClose={() => setPinsOpen(false)}
            onJump={(id) => {
              setPinsOpen(false);
              document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "center" });
            }}
          />
        )}
        <MessageList
          messages={messages ?? []}
          usersById={usersById}
          currentUserId={userId}
          readState={readState}
          pinnedIds={pinnedIds}
          onEdit={edit}
          onDelete={del}
          onReact={react}
          onOpenThread={setThreadParent}
          onTogglePin={togglePin}
        />
        <TypingIndicator userIds={typingUserIds} usersById={usersById} />
        {helpOpen && (
          <div className="mx-3 mb-2 border rounded bg-popover shadow-md text-sm">
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="font-medium">Available commands</span>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close help"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="py-1">
              {COMMANDS.map((c) => (
                <li key={c.name} className="px-3 py-1 flex gap-3">
                  <span className="font-mono text-xs w-36 shrink-0 text-foreground">{c.usage}</span>
                  <span className="text-xs text-muted-foreground">{c.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Composer
          orgId={orgId}
          channelLabel={label}
          onSend={send}
          onTyping={emitTyping}
          canManage={true}
          onCommand={runCommand}
          onHelp={() => setHelpOpen((o) => !o)}
          onDm={runDm}
        />
      </section>
      {threadParent && (
        <ThreadPane
          orgId={orgId}
          channelId={channelId}
          parentMessage={threadParent}
          currentUserId={userId}
          usersById={usersById}
          onClose={() => setThreadParent(null)}
          onSendReply={sendReply}
          onEdit={edit}
          onDelete={del}
        />
      )}
    </div>
  );
}
