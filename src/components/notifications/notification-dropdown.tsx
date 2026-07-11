"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bell,
  CheckCheck,
  Trash2,
  X,
  Check,
  Undo2,
  Loader2,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import type { Notification } from "@/types/models";
import {
  NOTIFICATION_CATEGORIES,
  categoryMatchesType,
  notificationTypeLabel,
} from "@/lib/notifications/categories";

const PAGE_SIZE = 20;

type FeedItem = Notification & { url?: string | null };

interface NotifPage {
  items: FeedItem[];
  nextCursor: string | null;
  unreadCount: number | null;
}

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

function fullTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

const FILTERS = [
  { key: "all", label: "All" },
  ...NOTIFICATION_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
];

interface NotificationDropdownProps {
  orgId: string;
}

export function NotificationDropdown({ orgId }: NotificationDropdownProps) {
  const [notifications, setNotifications] = useState<FeedItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState("all");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];

  // The SSE subscription is stable (keyed on orgId only); read the live filter
  // through a ref so a new notification can be prepended to the right view
  // without tearing down and re-opening the EventSource on every filter change.
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const loadPage = useCallback(
    async (cursor: string | null, activeFilter: string) => {
      if (!orgId) return;
      const reset = cursor === null;
      if (reset) setLoading(true);
      else setLoadingMore(true);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (activeFilter !== "all") qs.set("category", activeFilter);
        if (cursor) qs.set("cursor", cursor);
        const r = await fetch(
          `/api/v1/orgs/${orgId}/notifications?${qs.toString()}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as NotifPage;
        setNextCursor(data.nextCursor ?? null);
        if (typeof data.unreadCount === "number") setUnreadCount(data.unreadCount);
        setNotifications((prev) => {
          if (reset) return data.items;
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...data.items.filter((n) => !seen.has(n.id))];
        });
      } catch (err) {
        if (reset) {
          setNotifications([]);
          notifyError(err, "Couldn't load notifications.");
        } else {
          // Best-effort "load more": the page just stays put and the button
          // remains, so a toast would be noise.
          console.error("Failed to load more notifications:", err);
        }
      } finally {
        if (reset) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [orgId],
  );

  // (Re)load the first page on mount, org switch, and whenever the filter
  // changes. This is a deliberate fetch-from-remote sync; the setState it
  // performs after the await is the whole point.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage(null, filter);
  }, [loadPage, filter]);

  // Live SSE — bump the badge and prepend to the visible feed when the new
  // notification matches the active filter.
  useEffect(() => {
    if (!orgId) return;
    const es = new EventSource(`/api/v1/orgs/${orgId}/events`);
    const handler = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as FeedItem;
        setUnreadCount((c) => c + 1);
        const f = filterRef.current;
        if (f === "all" || categoryMatchesType(f, data.type)) {
          setNotifications((prev) =>
            prev.some((n) => n.id === data.id) ? prev : [data, ...prev],
          );
        }
      } catch {
        /* malformed event — skip */
      }
    };
    es.addEventListener("notification.created", handler as EventListener);
    return () => {
      es.removeEventListener("notification.created", handler as EventListener);
      es.close();
    };
  }, [orgId]);

  async function updateRead(n: FeedItem, read: boolean) {
    if (n.read === read) return;
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${n.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read } : x)),
      );
      setUnreadCount((c) => Math.max(0, c + (read ? -1 : 1)));
    } catch (err) {
      notifyError(err, "Couldn't update the notification.");
    }
  }

  async function dismiss(n: FeedItem) {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${n.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) => prev.filter((x) => x.id !== n.id));
      if (!n.read) setUnreadCount((c) => Math.max(0, c - 1));
    } catch (err) {
      notifyError(err, "Couldn't dismiss the notification.");
    }
  }

  async function markAllRead() {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch (err) {
      notifyError(err, "Couldn't mark all as read.");
    }
  }

  async function clearAll() {
    try {
      const qs = new URLSearchParams();
      if (filter !== "all") qs.set("category", filter);
      const res = await fetch(
        `/api/v1/orgs/${orgId}/notifications?${qs.toString()}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotifications([]);
      setNextCursor(null);
      // Resync the badge + any notifications outside the cleared slice.
      void loadPage(null, filter);
    } catch (err) {
      notifyError(err, "Couldn't clear notifications.");
    }
  }

  function handleNavigate(n: FeedItem) {
    void updateRead(n, true);
    setOpen(false);
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

  const hasAny = notifications.length > 0;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        aria-label="Notifications"
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground/80 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold text-destructive-foreground">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            data-slot="notification-feed"
            className="z-50 flex max-h-[70vh] w-96 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <p className="text-sm font-medium">Notifications</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={unreadCount === 0}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  title="Mark all as read"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Mark all read
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={!hasAny}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                  title={filter === "all" ? "Clear all notifications" : "Clear this list"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </button>
              </div>
            </div>

            {/* Type/category filter — a horizontally scrollable chip row. */}
            <div className="flex gap-1 overflow-x-auto border-y px-2 py-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap transition-colors",
                    filter === f.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && !hasAny ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              ) : !hasAny ? (
                <div className="py-10 text-center">
                  <Inbox className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    {filter === "all"
                      ? "No notifications yet"
                      : "Nothing in this category"}
                  </p>
                </div>
              ) : (
                <TooltipProvider delay={250}>
                  <ul className="divide-y">
                    {notifications.map((n) => (
                      <li
                        key={n.id}
                        className={cn(
                          "group/notif relative flex items-start gap-1 pr-1.5",
                          !n.read && "bg-muted/40",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                onClick={() => handleNavigate(n)}
                                className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-left outline-none focus-visible:bg-accent/60"
                              />
                            }
                          >
                            {!n.read ? (
                              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                            ) : (
                              <span className="mt-1.5 h-2 w-2 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                                  {notificationTypeLabel(n.type)}
                                </span>
                                <span
                                  className={cn(
                                    "truncate text-sm",
                                    !n.read && "font-medium",
                                  )}
                                >
                                  {n.title}
                                </span>
                              </span>
                              {n.body && (
                                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                                  {n.body}
                                </span>
                              )}
                              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                {timeAgo(n.createdAt)}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent
                            side="left"
                            align="start"
                            className="max-w-xs flex-col items-start gap-1 whitespace-normal text-left"
                          >
                            <span className="text-xs font-semibold">{n.title}</span>
                            {n.body && (
                              <span className="text-xs opacity-90">{n.body}</span>
                            )}
                            <span className="text-[10px] opacity-70">
                              {notificationTypeLabel(n.type)} ·{" "}
                              {fullTimestamp(n.createdAt)}
                            </span>
                            {n.url && (
                              <span className="text-[10px] opacity-70">
                                Click to open ↗
                              </span>
                            )}
                          </TooltipContent>
                        </Tooltip>

                        {/* Row actions — revealed on hover/focus. */}
                        <span className="flex shrink-0 items-center gap-0.5 pt-2.5 opacity-0 transition-opacity group-hover/notif:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={() => updateRead(n, !n.read)}
                            title={n.read ? "Mark as unread" : "Mark as read"}
                            aria-label={n.read ? "Mark as unread" : "Mark as read"}
                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            {n.read ? (
                              <Undo2 className="h-3.5 w-3.5" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => dismiss(n)}
                            title="Dismiss"
                            aria-label="Dismiss notification"
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>

                  {nextCursor && (
                    <div className="p-2">
                      <button
                        type="button"
                        onClick={() => void loadPage(nextCursor, filter)}
                        disabled={loadingMore}
                        className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        {loadingMore ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading…
                          </>
                        ) : (
                          "Load older notifications"
                        )}
                      </button>
                    </div>
                  )}
                </TooltipProvider>
              )}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
