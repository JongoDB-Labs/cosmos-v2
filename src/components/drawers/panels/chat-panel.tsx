"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useChatChannels,
  type ChatChannelSummary,
} from "@/hooks/use-chat-channels";
import { ChatForbiddenError } from "@/lib/chat/chat-forbidden";
import { useOrgQueryKey } from "@/lib/query/keys";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChannelView } from "@/components/chat/channel-view";
import { useDrawers, type DrawerSeed } from "../drawer-provider";
import { NoChatAccess } from "./no-chat-access";

interface ChatPanelProps {
  orgId: string;
  orgSlug: string;
  userId: string;
}

/** The conversation on screen, and a message in it to bring into view. */
interface OpenConversation {
  channelId: string;
  messageId?: string;
}

function conversationFrom(seed: DrawerSeed | null): OpenConversation | null {
  const t = seed?.chat;
  if (!t?.channelId) return null;
  return t.messageId ? { channelId: t.channelId, messageId: t.messageId } : { channelId: t.channelId };
}

/**
 * The Chat drawer, and the only place chat is shown. Master/detail: the full
 * `ChatSidebar` (project-grouped channels, DMs with presence, search, the
 * create, browse and new-DM dialogs), and the live `ChannelView` (messages,
 * composer, threads, reactions, pins) for the one you pick.
 *
 * Everything that moves between conversations happens HERE, in place: picking
 * a channel, a search hit, starting a DM (the dialog or `/dm`), leaving or
 * archiving a channel. None of it navigates the page behind the drawer.
 *
 * A link can name where to start (`?chat=<id>`, `?chatWith=<userId>`, see
 * `lib/chat/drawer-link`); it arrives as the drawer's seed, and a new seed
 * moves an already-open drawer to the new conversation.
 */
export function ChatPanel({ orgId, userId }: ChatPanelProps) {
  const { seed } = useDrawers();
  const { data, error } = useChatChannels(orgId);
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");

  const [open, setOpen] = useState<OpenConversation | null>(() => conversationFrom(seed));
  // People to start a direct message with, from a `?chatWith=` link.
  const [dmWith, setDmWith] = useState<string[] | null>(() => seed?.chat?.withUserIds ?? null);
  const [dmError, setDmError] = useState<string | null>(null);

  // A new seed while the drawer is already open moves it to the new target.
  // Adjusted during render (React's "reset state when a prop changes"), not in
  // an effect, so the old conversation never paints in between. A seed with no
  // chat target (the Chat tab clicked by hand) leaves the conversation alone.
  const [seenSeed, setSeenSeed] = useState(seed);
  if (seed !== seenSeed) {
    setSeenSeed(seed);
    const t = seed?.chat;
    if (t) {
      setDmError(null);
      if (t.withUserIds?.length) {
        setDmWith(t.withUserIds);
      } else {
        setDmWith(null);
        setOpen(conversationFrom(seed));
      }
    }
  }

  // Start (or reopen: the route returns the existing one) the DM a link asked
  // for, then open it. Guarded by the request itself rather than a cleanup
  // flag: StrictMode runs this effect twice, and a cleanup that cancelled the
  // first run would throw away the only response, so the DM would never open.
  const startedFor = useRef<string[] | null>(null);
  useEffect(() => {
    if (!dmWith || startedFor.current === dmWith) return;
    const request = dmWith;
    startedFor.current = request;
    void (async () => {
      let channelId: string | undefined;
      let problem: string | null = null;
      try {
        const r = await fetch(`/api/v1/orgs/${orgId}/chat/dms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userIds: request }),
        });
        const j = (await r.json().catch(() => null)) as
          | { channelId?: string; data?: { channelId?: string }; error?: string }
          | null;
        channelId = r.ok ? (j?.channelId ?? j?.data?.channelId) : undefined;
        if (!channelId) {
          problem =
            j?.error === "cannot_dm_yourself"
              ? "That link starts a conversation with yourself."
              : "Couldn't start that conversation. The person may have left this organization.";
        } else {
          // Wait for the list to hold the new DM, so it opens rather than
          // flashing "no longer exists".
          await qc.invalidateQueries({ queryKey: channelsKey });
        }
      } catch {
        problem = "Couldn't start that conversation. Check your connection and try the link again.";
      }
      // A newer link has taken over; this answer is for a request nobody wants.
      if (startedFor.current !== request) return;
      startedFor.current = null;
      setDmWith(null);
      if (channelId) setOpen({ channelId });
      else setDmError(problem);
    })();
  }, [dmWith, orgId, qc, channelsKey]);

  // Refused by the server (the role says chat, the member's own access does
  // not): say so, rather than the sidebar's "check your connection".
  if (error instanceof ChatForbiddenError) return <NoChatAccess />;

  const selected = open ? (data ?? []).find((c) => c.id === open.channelId) ?? null : null;
  // Asked for a conversation the list does not hold: gone, or not yours. Worded
  // the same either way, so a link cannot confirm that a private one exists.
  const missing = Boolean(open && data && !selected);

  function label(c: ChatChannelSummary): string {
    return c.kind === "CHANNEL"
      ? (c.name ?? c.id.slice(0, 6))
      : c.otherParticipants.map((p) => p.displayName).join(", ") || "DM";
  }

  const select = (channelId: string, messageId?: string) => {
    setDmError(null);
    setOpen(messageId ? { channelId, messageId } : { channelId });
  };
  const backToList = () => setOpen(null);

  // ── Detail: the selected channel's live conversation ──
  if (selected && open) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={backToList}
            aria-label="Back to channels"
            className="flex items-center gap-1.5 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
          >
            <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
            {label(selected)}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ChannelView
            // A different conversation is a different view: no thread pane or
            // pins panel carried over from the last one.
            key={selected.id}
            orgId={orgId}
            channelId={selected.id}
            userId={userId}
            focusMessageId={open.messageId}
            onOpenChannel={(id) => select(id)}
            onLeft={backToList}
          />
        </div>
      </div>
    );
  }

  const notice = dmWith
    ? "Opening the conversation…"
    : (dmError ??
      (missing ? "That conversation no longer exists, or you don't have access to it." : null));

  // ── Master: the full chat sidebar, selecting in place ──
  // Force the sidebar to fill the drawer (it's w-64 on the page) and drop its
  // right border since there's no chat pane beside it here.
  return (
    <div className="flex h-full flex-col">
      {notice && (
        <p
          role="status"
          className="shrink-0 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]"
        >
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto [&>aside]:!w-full [&>aside]:border-r-0">
        <ChatSidebar
          orgId={orgId}
          activeChannelId={open?.channelId}
          onSelectChannel={select}
        />
      </div>
    </div>
  );
}
