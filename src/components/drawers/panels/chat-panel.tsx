"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Hash, Lock, MessagesSquare } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { cn } from "@/lib/utils";
import {
  useChatChannels,
  type ChatChannelSummary,
} from "@/hooks/use-chat-channels";
import { ChannelView } from "@/components/chat/channel-view";

interface ChatPanelProps {
  orgId: string;
  orgSlug: string;
  userId: string;
}

/**
 * Chat as a DOCKED-DRAWER PANEL (body only — the DockedDrawer frame supplies
 * the tool tabs, resize, and close). Self-contained master/detail: a compact
 * channel + DM picker, then the full ChannelView (live messages + composer +
 * threads) for the selected channel. Selection is LOCAL state — we deliberately
 * do NOT route to /chat/[id] (which would navigate the page behind the drawer),
 * so chatting stays adjacent to whatever else is on screen.
 */
export function ChatPanel({ orgId, userId }: ChatPanelProps) {
  const { data, isLoading, isError, refetch } = useChatChannels(orgId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const channels = useMemo(
    () => (data ?? []).filter((c) => c.kind === "CHANNEL"),
    [data],
  );
  const dms = useMemo(
    () => (data ?? []).filter((c) => c.kind !== "CHANNEL"),
    [data],
  );

  const selected = useMemo(
    () => (data ?? []).find((c) => c.id === selectedId) ?? null,
    [data, selectedId],
  );

  function dmLabel(c: ChatChannelSummary): string {
    return c.otherParticipants.map((p) => p.displayName).join(", ") || "DM";
  }

  // ── Detail: the selected channel's live conversation ──
  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            aria-label="Back to channels"
            className="flex items-center gap-1.5 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
          >
            <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
            {selected.kind === "CHANNEL"
              ? (selected.name ?? "Channel")
              : dmLabel(selected)}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ChannelView orgId={orgId} channelId={selected.id} userId={userId} />
        </div>
      </div>
    );
  }

  // ── Master: channel + DM picker ──
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
        <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
          <MessagesSquare className="h-4 w-4 text-[var(--primary)]" />
          Chat
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isError ? (
          <LoadError onRetry={() => void refetch()} />
        ) : isLoading || !data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <section>
              <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Channels
              </h3>
              {channels.length === 0 ? (
                <p className="px-1 text-xs text-[var(--text-muted)]">
                  No channels yet.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {channels.map((c) => {
                    const Icon = c.isPrivate ? Lock : Hash;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                            "text-[var(--text)] hover:bg-[var(--primary-tint)]",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                          <span className="truncate">
                            {c.name ?? c.id.slice(0, 6)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Direct messages
              </h3>
              {dms.length === 0 ? (
                <p className="px-1 text-xs text-[var(--text-muted)]">
                  No direct messages.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {dms.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--primary-tint)]"
                      >
                        <span className="truncate">{dmLabel(c)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
