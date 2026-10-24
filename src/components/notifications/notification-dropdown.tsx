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
import { Bell, Check, Mail, MailOpen, X } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import type { Notification } from "@/types/models";
import { notificationHref } from "@/lib/notifications/href";
import { NotificationPreview } from "./notification-preview";
import {
  announceNotificationsChanged,
  onNotificationsChanged,
} from "@/lib/notifications/changed";

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
  | "id"
  | "type"
  | "title"
  | "body"
  | "read"
  | "url"
  | "refType"
  | "refId"
  | "createdAt"
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
  // Bumped when the Inbox page changes notifications under the bell.
  const [reloads, setReloads] = useState(0);
  useEffect(
    () => onNotificationsChanged("bell", () => setReloads((n) => n + 1)),
    [],
  );

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
        setLoadFailed(false);
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
  }, [orgId, reloads]);

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
      announceNotificationsChanged("bell");
    } catch (err) {
      console.error("Failed to mark all notifications read:", err);
      notifyError(err, "Couldn't mark all as read.");
    }
  }

  // Clearing deletes. Like read/unread, the list changes only once the server
  // has done it.
  async function clearOne(id: string) {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      announceNotificationsChanged("bell");
    } catch (err) {
      notifyError(err, "Couldn't clear that notification.");
    }
  }

  // Two steps, in place: a dialog opened from inside a dropdown menu would
  // close the menu under it, and this can't be undone.
  const [confirmingClear, setConfirmingClear] = useState(false);
  async function clearAll() {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications([]);
      setUnreadNotLoaded(0);
      setCursor(null);
      announceNotificationsChanged("bell");
    } catch (err) {
      notifyError(err, "Couldn't clear your notifications.");
    } finally {
      setConfirmingClear(false);
    }
  }

  // Read or unread, one notification. The row changes only once the server
  // has it, so the badge never shows a state that didn't persist.
  async function setRead(id: string, read: boolean, quiet = false) {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read } : n)),
      );
      announceNotificationsChanged("bell");
    } catch (err) {
      // Opening a notification marks it read on the way past; failing that is
      // trivial and self-heals on the next load, so it stays quiet. Asking for
      // read or unread outright and not getting it deserves to be told.
      if (!quiet) {
        notifyError(
          err,
          read ? "Couldn't mark that read." : "Couldn't mark that unread.",
        );
        return;
      }
      console.error("Failed to mark notification read:", err);
    }
  }

  const unreadCount =
    unreadNotLoaded + notifications.filter((n) => !n.read).length;

  function handleNotificationClick(n: BellItem) {
    if (!n.read) void setRead(n.id, true, true);
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
          {confirmingClear ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">Clear all?</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingClear(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  void clearAll();
                }}
              >
                Clear
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
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
              {notifications.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingClear(true);
                  }}
                >
                  Clear all…
                </Button>
              )}
            </div>
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
              // The toggle sits beside the item, not inside it: a button
              // nested in a menuitem is two controls in one, and using it
              // would also open the notification.
              <NotificationPreview
                key={notification.id}
                orgId={orgId}
                notification={notification}
              >
                <div
                  className={cn(
                    "flex items-start",
                    !notification.read && "bg-muted/50",
                  )}
                >
                  <DropdownMenuItem
                    className="min-w-0 flex-1 flex-col items-start gap-1 py-2.5"
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
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1.5 mr-1 shrink-0 text-muted-foreground"
                    aria-label={
                      notification.read
                        ? `Mark "${notification.title}" unread`
                        : `Mark "${notification.title}" read`
                    }
                    title={notification.read ? "Mark unread" : "Mark read"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void setRead(notification.id, !notification.read);
                    }}
                  >
                    {notification.read ? (
                      <Mail className="size-4" />
                    ) : (
                      <MailOpen className="size-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1.5 mr-1 shrink-0 text-muted-foreground"
                    aria-label={`Clear "${notification.title}"`}
                    title="Clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      void clearOne(notification.id);
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </NotificationPreview>
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
