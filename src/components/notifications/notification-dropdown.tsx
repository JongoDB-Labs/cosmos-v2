"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bell, Check } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import type { Notification } from "@/types/models";
import { notificationHref } from "@/lib/notifications/href";

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

/** What the bell shows of a notification; the inbox endpoint's row shape. */
type BellItem = Pick<
  Notification,
  "id" | "title" | "body" | "read" | "url" | "createdAt"
>;

type InboxPage = {
  data: BellItem[];
  nextCursor: string | null;
  counts: { unread: number };
};

/** One page per fetch. Enough to fill the panel and then some. */
const PAGE_SIZE = 20;

export function NotificationDropdown({ orgId }: NotificationDropdownProps) {
  const [notifications, setNotifications] = useState<BellItem[]>([]);
  // Unread notifications the server counted that aren't loaded yet. The badge
  // is these plus the loaded unread rows, so it shows the whole inbox's count
  // from the first page rather than growing as older pages scroll in.
  const [unreadNotLoaded, setUnreadNotLoaded] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const sseRef = useRef<EventSource | null>(null);
  // State, not refs: the panel mounts inside the menu's own render, so only a
  // state change tells this component the sentinel now exists to observe.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLButtonElement | null>(null);

  // First page, through the same paged endpoint the inbox reads, so scrolling
  // can carry on from its cursor.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/v1/orgs/${orgId}/notifications/inbox?unreadOnly=false&limit=${PAGE_SIZE}`,
        );
        if (!r.ok) return;
        const page: InboxPage = await r.json();
        if (cancelled) return;
        setNotifications(page.data);
        setCursor(page.nextCursor);
        setUnreadNotLoaded(
          Math.max(
            0,
            page.counts.unread - page.data.filter((n) => !n.read).length,
          ),
        );
      } catch {
        /* silently fail; SSE will deliver new ones anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function loadOlder() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadFailed(false);
    try {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/notifications/inbox?unreadOnly=false&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const page: InboxPage = await r.json();
      setNotifications((prev) => {
        const have = new Set(prev.map((n) => n.id));
        return [...prev, ...page.data.filter((n) => !have.has(n.id))];
      });
      setCursor(page.nextCursor);
      setUnreadNotLoaded((c) =>
        Math.max(0, c - page.data.filter((n) => !n.read).length),
      );
    } catch {
      // Shown in the panel; the button stays so the next try is one click.
      setLoadFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Reaching the foot of the list loads the next page. The sentinel is also a
  // button, so a keyboard or a browser without observers can still ask.
  // Re-armed on every render: while the sentinel stays in view (a short page
  // that doesn't fill the panel) it keeps loading, and loadOlder's own guard
  // keeps that to one request at a time.
  const hasMore = cursor !== null;
  useEffect(() => {
    if (
      !sentinel ||
      !hasMore ||
      loadFailed ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { root: scrollEl, rootMargin: "120px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // Live SSE — prepend new notifications as they arrive.
  useEffect(() => {
    if (!orgId) return;
    const es = new EventSource(`/api/v1/orgs/${orgId}/events`);
    sseRef.current = es;
    const handler = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BellItem;
        setNotifications((prev) =>
          prev.some((n) => n.id === data.id) ? prev : [data, ...prev],
        );
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

  async function markAllRead() {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadNotLoaded(0);
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

  const unreadCount =
    unreadNotLoaded + notifications.filter((n) => !n.read).length;

  function handleNotificationClick(n: BellItem) {
    markRead(n.id);
    if (!orgSlug || !n.url) return;
    router.push(notificationHref(orgSlug, n.url));
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
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--status-critical-text)] text-[9px] font-bold text-[var(--bg)]">
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
          // Its own scroll region, so older notifications are a scroll away
          // instead of cut off at ten.
          <div
            ref={setScrollEl}
            className="max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain"
            data-testid="notification-scroll"
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
            {hasMore ? (
              <button
                ref={setSentinel}
                type="button"
                className="w-full px-3 py-2 text-center text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                disabled={loadingMore}
                onClick={(e) => {
                  e.stopPropagation();
                  void loadOlder();
                }}
              >
                {loadingMore
                  ? "Loading older…"
                  : loadFailed
                    ? "Couldn't load older notifications. Try again"
                    : "Load older"}
              </button>
            ) : (
              <p className="px-3 py-2 text-center text-xs text-muted-foreground">
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
