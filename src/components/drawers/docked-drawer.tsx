"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  MessagesSquare,
  FileText,
  MessageSquarePlus,
  Video,
  X,
  Maximize2,
  Minimize2,
  PanelRightClose,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Z_ASSISTANT } from "@/lib/ui/layers";
import { useBrand } from "@/components/providers/brand-provider";
import { DrawerTab, DRAWER_TAB_WIDTH, focusDrawerTab } from "./drawer-tab";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import {
  useDrawers,
  type DrawerTool,
  DRAWER_MIN_WIDTH,
  DRAWER_MAX_WIDTH,
} from "./drawer-provider";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { ChatPanel } from "./panels/chat-panel";
import { NoChatAccess } from "./panels/no-chat-access";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
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
/** The aside's id: the side tab and the Minimize button point at it. */
export const DRAWER_ID = "cosmos-drawer";

/**
 * The single NON-MODAL docked drawer. Unlike a Sheet/Dialog there is NO backdrop,
 * NO blur, and NO focus trap — the page behind stays fully interactive. On
 * desktop it docks on the right and the main content reflows beside it (via the
 * `--cosmos-drawer-w` CSS var the shell's content column reads); on mobile it
 * goes full-width (no room to dock side-by-side). The left edge is a drag handle
 * to resize; the header switches between the five tools.
 */
export function DockedDrawer({ orgId, orgSlug, userId }: DockedDrawerProps) {
  const { tool, minimized, minimize, restore, close, open, isOpen, width, setWidth } =
    useDrawers();
  const brand = useBrand();
  // Chat follows the topbar's gate: every chat route requires CHAT_USE, so
  // without it the tab would open onto a load that cannot succeed.
  const { can } = usePermissions();
  const chatAllowed = can(Permission.CHAT_USE);
  const tools = chatAllowed ? TOOLS : TOOLS.filter((t) => t.id !== "chat");
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const resizing = useRef(false);
  /** Aborts the in-flight drag's listeners — one controller per drag. */
  const drag = useRef<AbortController | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);

  // `docked`: a tool is selected (open OR minimized) and an org is in context.
  const docked = tool !== null && Boolean(orgId) && Boolean(orgSlug);
  const shown = docked && !minimized;

  // The assistant stays mounted while minimized (its conversation, draft and a
  // streaming reply survive), but only once it has actually been shown: after
  // a reload into the minimized state, or a minimize from the corner button,
  // nothing is mounted (no requests) until the first restore. Other tools
  // unmount on minimize exactly as on close — a hidden Chat would otherwise
  // keep marking incoming messages read.
  const [assistantLive, setAssistantLive] = useState(false);
  const wantLive = docked && tool === "assistant" && (assistantLive || shown);
  if (wantLive !== assistantLive) setAssistantLive(wantLive);

  // Other surfaces (mobile bottom nav, command palette, wake word) open the
  // assistant with this event. Listened for here, because the corner button
  // that used to own it is unmounted while the drawer is minimized.
  useEffect(() => {
    const onOpen = () => open("assistant");
    window.addEventListener("cosmos:agent:open", onOpen);
    return () => window.removeEventListener("cosmos:agent:open", onOpen);
  }, [open]);

  // Reflow the main content beside the drawer (desktop only) by publishing the
  // width as a CSS var the shell's content column consumes: the drawer's width
  // when shown, the side tab's while minimized, 0 when closed and on phones.
  useEffect(() => {
    const root = document.documentElement;
    const w = !docked || !isDesktop ? 0 : minimized ? DRAWER_TAB_WIDTH : width;
    root.style.setProperty("--cosmos-drawer-w", `${w}px`);
    return () => root.style.setProperty("--cosmos-drawer-w", "0px");
  }, [docked, minimized, isDesktop, width]);

  const doMinimize = useCallback(() => {
    minimize();
    focusDrawerTab();
  }, [minimize]);

  const doRestore = useCallback(() => {
    restore();
    // After the restore commits (hidden/inert removed): the assistant's
    // composer on desktop when it can take input, otherwise the Minimize
    // button. Phones skip the composer so restoring doesn't pop the keyboard.
    requestAnimationFrame(() => {
      const composer =
        isDesktop && tool === "assistant"
          ? asideRef.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
          : null;
      (composer ?? minimizeRef.current)?.focus();
    });
  }, [restore, isDesktop, tool]);

  /**
   * Escape minimizes (never closes, so a stray key can't throw away a draft),
   * and only for keys pressed inside the drawer: this is the aside's own
   * handler, not a window listener. Keys another control already handled — a
   * menu, an @-mention list, IME composition — are left alone, and every Escape
   * from inside the drawer stops here, so a page's own window-level Escape
   * (timeline fullscreen) never acts on a key meant for the drawer.
   */
  const onAsideKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (e.defaultPrevented || e.nativeEvent.isComposing) return;
      e.preventDefault();
      doMinimize();
    },
    [doMinimize],
  );

  /**
   * Drag the left edge to resize.
   *
   * Every way a drag can END has to reach the same cleanup. The first version
   * listened for `pointerup` alone, so a drag that finished any other way —
   * `pointercancel` (an OS or trackpad gesture taking over), the window losing
   * focus mid-drag, pointer capture lost because the handle unmounted — left
   * `onMove` live on `window` for the rest of the page's life. And `onMove` did
   * not test whether a button was still held, so from then on the drawer
   * tracked the BARE pointer: its edge followed the mouse with nothing pressed,
   * which is what "the widget darts around the screen" looks like from the
   * outside. Each new drag then added another live listener on top.
   *
   * Three things close that: one `stop` reached from pointerup, pointercancel
   * and blur; an `ev.buttons === 0` backstop that ends a drag whose release was
   * missed on the very next move; and an AbortController per drag, so the
   * listeners cannot outlive it and a second pointerdown cannot stack a second
   * set. `stop` does not name `onMove` (abort removes them all), so there is no
   * mutual reference to order.
   */
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const handle = e.target as Element;
      const pointerId = e.pointerId;

      drag.current?.abort(); // never stack a second drag on an unfinished one
      const ac = new AbortController();
      drag.current = ac;
      resizing.current = true;
      handle.setPointerCapture?.(pointerId);

      const stop = () => {
        if (!resizing.current) return;
        resizing.current = false;
        ac.abort();
        try {
          handle.releasePointerCapture?.(pointerId);
        } catch {
          /* capture already lost — that is often WHY we are stopping */
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (!resizing.current) return;
        // No button held ⇒ the release was missed. End the drag instead of
        // following the pointer around.
        if (ev.buttons === 0) {
          stop();
          return;
        }
        setWidth(window.innerWidth - ev.clientX);
      };

      const opts = { signal: ac.signal };
      window.addEventListener("pointermove", onMove, opts);
      window.addEventListener("pointerup", stop, opts);
      window.addEventListener("pointercancel", stop, opts);
      window.addEventListener("lostpointercapture", stop, opts);
      window.addEventListener("blur", stop, opts);
    },
    [setWidth],
  );

  // A drag in flight must not outlive the drawer.
  useEffect(() => () => drag.current?.abort(), []);

  if (!docked || !orgId || !orgSlug || !tool) return null;

  const isWide = width >= WIDE_WIDTH - 10;
  const meta = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];
  const tabLabel = tool === "assistant" ? brand.agentName : meta.label;

  return (
    <>
    {minimized && (
      <DrawerTab
        label={tabLabel}
        icon={meta.icon}
        controls={DRAWER_ID}
        onRestore={doRestore}
        isDesktop={isDesktop}
      />
    )}
    <aside
      ref={asideRef}
      id={DRAWER_ID}
      // NON-MODAL: a plain fixed panel — NO Dialog/backdrop, so the page stays
      // interactive and unblurred behind it.
      role="complementary"
      aria-label={`${tool} drawer`}
      // Minimized: kept in the tree (so the assistant stays mounted) but out of
      // view, the tab order and the accessibility tree.
      hidden={minimized}
      inert={minimized}
      onKeyDown={onAsideKeyDown}
      className={cn(
        "fixed right-0 top-0 bottom-0 flex flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-glow)]",
        Z_ASSISTANT,
        minimized && "hidden",
      )}
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
          {tools.map((t) => {
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
            ref={minimizeRef}
            type="button"
            onClick={doMinimize}
            aria-label="Minimize drawer"
            aria-expanded="true"
            aria-controls={DRAWER_ID}
            title="Minimize to side tab"
            className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
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

      {/* Active tool body. Each panel mounts only while selected (and, except
          the assistant, only while shown). Keyed by org so a panel kept
          mounted while minimized can never act in the previous org. */}
      <div key={orgId} className="min-h-0 flex-1 overflow-hidden">
        {tool === "assistant" && wantLive && <AssistantPanel orgId={orgId} />}
        {shown && tool === "chat" &&
          (chatAllowed ? (
            <ChatPanel orgId={orgId} orgSlug={orgSlug} userId={userId} />
          ) : (
            // Opened anyway, by a chat link: no request that would be refused.
            <NoChatAccess />
          ))}
        {shown && tool === "notes" && <NotesPanel orgId={orgId} orgSlug={orgSlug} />}
        {shown && tool === "meetings" && (
          <MeetingsPanel orgId={orgId} orgSlug={orgSlug} />
        )}
        {shown && tool === "feedback" && (
          <FeedbackPanel orgId={orgId} orgSlug={orgSlug} />
        )}
      </div>
    </aside>
    </>
  );
}

export { DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH };
