"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bell, Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import type { Notification } from "@/types/models";

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

interface NotificationDropdownProps {
  orgId: string;
}

/** One page of history. Small enough that opening the bell stays cheap on a
 *  500-notice inbox, big enough that the first page fills the panel. */
const PAGE_SIZE = 25;

export function NotificationDropdown({ orgId }: NotificationDropdownProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const sseRef = useRef<EventSource | null>(null);
  // `createdAt` of the oldest row we hold — the cursor for the next page. A ref,
  // not state, so the observer below doesn't have to be rebuilt to see it.
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  // Callback refs rather than `useRef`: the panel is portalled and only mounts
  // when the bell is open, so an effect keyed on a ref object would never see it.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);

  // Initial REST fetch — the newest page, not the whole inbox.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/v1/orgs/${orgId}/notifications?limit=${PAGE_SIZE}`);
        if (!r.ok) return;
        const data: Notification[] = await r.json();
        if (cancelled) return;
        setNotifications(data);
        cursorRef.current = data.length ? data[data.length - 1].createdAt : null;
        // A short page is the end of history; a full one means ask again.
        setHasMore(data.length === PAGE_SIZE);
      } catch {
        /* silently fail; SSE will deliver new ones anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Append the next page of older notifications. Guarded by `inFlightRef` so a
  // burst of intersections (scroll is continuous) still fetches each page once.
  const loadOlder = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!orgId || !cursor || inFlightRef.current) return;
    inFlightRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/notifications?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!r.ok) return; // leave `hasMore` set — scrolling again retries
      const page: Notification[] = await r.json();
      if (page.length) {
        cursorRef.current = page[page.length - 1].createdAt;
        setNotifications((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...page.filter((n) => !seen.has(n.id))];
        });
      }
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      /* transient — the sentinel tries again on the next scroll */
    } finally {
      inFlightRef.current = false;
      setLoadingOlder(false);
    }
  }, [orgId]);

  // Auto-load on scroll: a sentinel at the foot of the list asks for the next
  // page as it comes into view. Rebuilt whenever the list grows, because an
  // observer only reports a CHANGE in intersection — if a freshly appended page
  // still leaves the sentinel visible, nothing would fire a second time.
  useEffect(() => {
    if (!scrollEl || !sentinelEl || !hasMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { root: scrollEl, rootMargin: "120px" },
    );
    io.observe(sentinelEl);
    return () => io.disconnect();
  }, [scrollEl, sentinelEl, hasMore, loadOlder, notifications.length]);

  // Live SSE — prepend new notifications as they arrive.
  useEffect(() => {
    if (!orgId) return;
    const es = new EventSource(`/api/v1/orgs/${orgId}/events`);
    sseRef.current = es;
    const handler = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as Notification & {
          url?: string | null;
        };
        setNotifications((prev) => {
          if (prev.some((n) => n.id === data.id)) return prev;
          return [data, ...prev];
        });
      } catch {
        /* malformed event — skip */
      }
    };
    es.addEventListener("notification.created", handler as EventListener);
    return () => {
      es.removeEventListener("notification.created", handler as EventListener);
      es.close();
      sseRef.current = null;
    };
  }, [orgId]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  async function markAllRead() {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (err) {
      console.error("Failed to mark all notifications read:", err);
      notifyError(err, "Couldn't mark all as read.");
    }
  }

  async function markRead(id: string) {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
      // Only reflect "read" in the UI if the server accepted it — otherwise the
      // badge would lie. (No toast: marking one read is trivial and self-heals.)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
    } catch (err) {
      // Deliberately silent: marking one notification read is trivial and
      // self-heals on the next load; a toast here would just be noise.
      // eslint-disable-next-line no-restricted-syntax
      console.error("Failed to mark notification read:", err);
    }
  }

  function handleNotificationClick(n: Notification & { url?: string | null }) {
    markRead(n.id);
    if (!orgSlug || !n.url) return;
    let path = n.url.startsWith("/") ? n.url : `/${n.url}`;
    // Notification creators are inconsistent: some store an org-relative URL
    // (e.g. "/notes/x") and others an already-org-slug-prefixed one (e.g.
    // "/{slug}/meetings/x"). Strip a leading "/{orgSlug}" if present so we
    // re-prefix exactly once — otherwise meeting/work-item/comment links became
    // "/{slug}/{slug}/…" and 404'd.
    if (path === `/${orgSlug}` || path.startsWith(`/${orgSlug}/`)) {
      path = path.slice(`/${orgSlug}`.length) || "/";
    }
    router.push(path === "/" ? `/${orgSlug}` : `/${orgSlug}${path}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 relative"
            aria-label={
              unreadCount > 0
                ? `Notifications, ${unreadCount} unread`
                : "Notifications"
            }
          />
        }
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1 h-7"
              onClick={(e) => {
                e.stopPropagation();
                markAllRead();
              }}
            >
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />

        {notifications.length === 0 ? (
          <div className="py-8 text-center">
            <Bell className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-sm text-muted-foreground">
              No notifications yet
            </p>
          </div>
        ) : (
          <div
            ref={setScrollEl}
            data-slot="notification-feed"
            aria-label="Notifications feed"
            className="max-h-80 overflow-y-auto overscroll-contain"
          >
            {notifications.map((notification) => (
              <DropdownMenuItem
                key={notification.id}
                className={cn(
                  "flex-col items-start gap-1 py-2.5",
                  !notification.read && "bg-muted/50",
                )}
                onClick={() => handleNotificationClick(notification)}
              >
                <div className="flex items-start gap-2 w-full">
                  {!notification.read && (
                    <div className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-sm truncate",
                        !notification.read && "font-medium",
                      )}
                    >
                      {notification.title}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {notification.body}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {timeAgo(notification.createdAt)}
                    </p>
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
            {hasMore && <div ref={setSentinelEl} aria-hidden className="h-px" />}
            {loadingOlder && (
              <div
                role="status"
                className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading older notifications…
              </div>
            )}
            {!hasMore && (
              <p className="py-3 text-center text-[10px] text-muted-foreground">
                No older notifications
              </p>
            )}
          </div>
        )}
        <div className="border-t border-[var(--border)] px-3 py-2">
          <Link
            href={`/${orgSlug}/inbox`}
            className="text-sm text-[var(--primary)] hover:underline"
          >
            Open inbox
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
