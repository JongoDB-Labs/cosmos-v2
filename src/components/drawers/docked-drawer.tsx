"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  Sparkles,
  MessagesSquare,
  FileText,
  MessageSquarePlus,
  Video,
  X,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import {
  useDrawers,
  type DrawerTool,
  DRAWER_MIN_WIDTH,
  DRAWER_MAX_WIDTH,
} from "./drawer-provider";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { ChatPanel } from "./panels/chat-panel";
import { NotesPanel } from "./panels/notes-panel";
import { FeedbackPanel } from "./panels/feedback-panel";
import { MeetingsPanel } from "./panels/meetings-panel";

interface DockedDrawerProps {
  orgId: string | undefined;
  orgSlug: string | undefined;
  /** Current user id — ChatPanel needs it to render the live ChannelView. */
  userId: string;
}

// Order mirrors the topbar nav "Chat · Meetings · Notes" (Meetings before
// Notes), with Assistant leading and Feedback trailing.
const TOOLS: { id: DrawerTool; label: string; icon: typeof Sparkles }[] = [
  { id: "assistant", label: "Assistant", icon: Sparkles },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "meetings", label: "Meetings", icon: Video },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "feedback", label: "Feedback", icon: MessageSquarePlus },
];

const WIDE_WIDTH = 720;

/**
 * The single NON-MODAL docked drawer. Unlike a Sheet/Dialog there is NO backdrop,
 * NO blur, and NO focus trap — the page behind stays fully interactive. On
 * desktop it docks on the right and the main content reflows beside it (via the
 * `--cosmos-drawer-w` CSS var the shell's content column reads); on mobile it
 * goes full-width (no room to dock side-by-side). The left edge is a drag handle
 * to resize; the header switches between the five tools.
 */
export function DockedDrawer({ orgId, orgSlug, userId }: DockedDrawerProps) {
  const { tool, close, open, isOpen, width, setWidth } = useDrawers();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const resizing = useRef(false);

  const docked = tool !== null && Boolean(orgId) && Boolean(orgSlug);

  // Reflow the main content beside the drawer (desktop only) by publishing the
  // width as a CSS var the shell's content column consumes. Cleared when closed.
  useEffect(() => {
    const root = document.documentElement;
    if (docked && isDesktop) {
      root.style.setProperty("--cosmos-drawer-w", `${width}px`);
    } else {
      root.style.setProperty("--cosmos-drawer-w", "0px");
    }
    return () => root.style.setProperty("--cosmos-drawer-w", "0px");
  }, [docked, isDesktop, width]);

  // Escape closes (non-modal, so we listen globally only while open).
  useEffect(() => {
    if (!docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docked, close]);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      resizing.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        if (!resizing.current) return;
        setWidth(window.innerWidth - ev.clientX);
      };
      const onUp = () => {
        resizing.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setWidth],
  );

  if (!docked || !orgId || !orgSlug) return null;

  const isWide = width >= WIDE_WIDTH - 10;

  return (
    <aside
      // NON-MODAL: a plain fixed panel — NO Dialog/backdrop, so the page stays
      // interactive and unblurred behind it.
      role="complementary"
      aria-label={`${tool} drawer`}
      className="fixed right-0 top-0 bottom-0 z-40 flex flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-glow)]"
      style={{ width: isDesktop ? width : "100%" }}
    >
      {/* Resize handle (desktop only) — drag the left edge to widen/narrow. */}
      {isDesktop && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          onPointerDown={onResizePointerDown}
          className="absolute left-0 top-0 bottom-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[var(--primary)]/40"
          title="Drag to resize"
        />
      )}

      {/* Header: tool tabs + expand/close */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 border-b border-[var(--border)] px-2">
        <div className="flex items-center gap-0.5">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            const active = isOpen(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => open(t.id)}
                aria-label={t.label}
                aria-current={active ? "true" : undefined}
                title={t.label}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-[var(--primary-tint)] text-[var(--primary)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {active && <span className="hidden sm:inline">{t.label}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">
          {isDesktop && (
            <button
              type="button"
              onClick={() => setWidth(isWide ? 460 : WIDE_WIDTH)}
              aria-label={isWide ? "Shrink drawer" : "Expand drawer"}
              title={isWide ? "Shrink" : "Expand"}
              className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            >
              {isWide ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close drawer"
            title="Close"
            className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Active tool body. Each panel mounts only while selected. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tool === "assistant" && <AssistantPanel orgId={orgId} />}
        {tool === "chat" && (
          <ChatPanel orgId={orgId} orgSlug={orgSlug} userId={userId} />
        )}
        {tool === "notes" && <NotesPanel orgId={orgId} orgSlug={orgSlug} />}
        {tool === "meetings" && (
          <MeetingsPanel orgId={orgId} orgSlug={orgSlug} />
        )}
        {tool === "feedback" && (
          <FeedbackPanel orgId={orgId} orgSlug={orgSlug} />
        )}
      </div>
    </aside>
  );
}

export { DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH };
