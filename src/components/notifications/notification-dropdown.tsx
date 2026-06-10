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

export function NotificationDropdown({ orgId }: NotificationDropdownProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const sseRef = useRef<EventSource | null>(null);

  // Initial REST fetch for the unread list.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/v1/orgs/${orgId}/notifications`);
        if (!r.ok) return;
        const data: Notification[] = await r.json();
        if (!cancelled) setNotifications(data);
      } catch {
        /* silently fail; SSE will deliver new ones anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

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

  function handleNotificationClick(
    n: Notification & { url?: string | null },
  ) {
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
            aria-label="Notifications"
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
          notifications.slice(0, 10).map((notification) => (
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
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
