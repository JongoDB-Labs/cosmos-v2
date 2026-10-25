"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { notificationHref } from "@/lib/notifications/href";
import { kindLabel } from "@/lib/notifications/kind";
import { NotificationPreview } from "./notification-preview";
import { announceNotificationsChanged, onNotificationsChanged } from "@/lib/notifications/changed";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { Inbox as InboxIcon, Mail, MailOpen, X } from "lucide-react";

/**
 * Everything waiting on you.
 *
 * The counts come before the list on purpose. An inbox of 524 where 431 are the
 * same notice is a different morning from 524 spread evenly, and a list — of
 * any length — cannot say which you are looking at. Picking a kind narrows the
 * list; the counts keep describing the whole inbox so there is a way back.
 */

type Row = {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  refType: string | null;
  refId: string | null;
  read: boolean;
  createdAt: string;
};

type Page = {
  data: Row[];
  nextCursor: string | null;
  counts: { total: number; unread: number; byType: { type: string; count: number }[] };
};

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function InboxWorkspace({ orgId }: { orgId: string }) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();
  // The bell writes too; when it does, this page's copy is stale.
  useEffect(() => onNotificationsChanged("inbox", () => void qc.invalidateQueries({ queryKey: ["org"] })), [qc]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [type, setType] = useState<string | null>(null);
  const key = useOrgQueryKey(["inbox", unreadOnly ? "unread" : "all", type ?? "any"]);

  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      jsonFetch<Page>(
        `/api/v1/orgs/${orgId}/notifications/inbox?unreadOnly=${unreadOnly}` +
          (type ? `&type=${encodeURIComponent(type)}` : "") +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });

  const readAll = useMutation({
    mutationFn: async (only: string | null) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read-all", ...(only ? { type: only } : {}) }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not mark those read");
      return res.json();
    },
    onSuccess: () => {
      announceNotificationsChanged("inbox");
      return qc.invalidateQueries({ queryKey: ["org"] });
    },
  });

  // One notification at a time, through the per-row endpoints the inbox never
  // used: there was "Mark all read" and nothing for the one you meant.
  const markOne = useMutation({
    mutationFn: async ({ id, read }: { id: string; read: boolean }) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read }),
      });
      if (!res.ok) throw new Error("Could not update that notification");
    },
    onSuccess: () => {
      announceNotificationsChanged("inbox");
      return qc.invalidateQueries({ queryKey: ["org"] });
    },
  });
  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not clear that notification");
    },
    onSuccess: () => {
      announceNotificationsChanged("inbox");
      return qc.invalidateQueries({ queryKey: ["org"] });
    },
  });
  // Clears what the view lists and nothing else: the picked kind, unread only
  // when that is what is showing. The server applies the same filters.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearView = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/orgs/${orgId}/notifications/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear", unreadOnly, ...(type ? { type } : {}) }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not clear those");
      return res.json();
    },
    onSuccess: () => {
      setConfirmingClear(false);
      setType(null);
      announceNotificationsChanged("inbox");
      return qc.invalidateQueries({ queryKey: ["org"] });
    },
  });
  const rowError = (markOne.error ?? dismiss.error) as Error | null;

  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts;
  // How many the view holds: a kind's count already follows the unread toggle;
  // with no kind picked, it is the unread or the whole total.
  const inView = type
    ? (counts?.byType.find((t) => t.type === type)?.count ?? 0)
    : unreadOnly
      ? (counts?.unread ?? 0)
      : (counts?.total ?? 0);

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;

  const chip = (value: string | null, label: string, n?: number) => (
    <button
      key={value ?? "all"}
      type="button"
      onClick={() => setType(value)}
      className={cn(
        "rounded-full border px-3 py-1 text-sm",
        type === value
          ? "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]"
          : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
      )}
    >
      {label}
      {n !== undefined && <span className="ml-1.5 tabular-nums">{n}</span>}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {/* The kind chips count what the toggle shows; so does this one. */}
        {chip(null, "Everything", unreadOnly ? counts?.unread : counts?.total)}
        {(counts?.byType ?? []).map((t) => chip(t.type, kindLabel(t.type), t.count))}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setUnreadOnly((v) => !v)}>
            {unreadOnly ? "Showing unread" : "Showing everything"}
          </Button>
          <Button
            size="sm"
            onClick={() => readAll.mutate(type)}
            disabled={readAll.isPending || (counts?.unread ?? 0) === 0}
          >
            {type ? `Mark ${kindLabel(type)} read` : "Mark all read"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmingClear(true)} disabled={inView === 0}>
            {type ? `Clear ${kindLabel(type)}…` : "Clear all…"}
          </Button>
        </div>
      </div>

      <Dialog open={confirmingClear} onOpenChange={(o) => !o && setConfirmingClear(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Clear {inView} {inView === 1 ? "notification" : "notifications"}?
            </DialogTitle>
            <DialogDescription>
              {unreadOnly ? "Every unread" : "Every"}
              {type ? ` “${kindLabel(type)}”` : ""} notification in this view is removed from your inbox. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          {clearView.isError && <p className="text-sm text-red-500">{(clearView.error as Error).message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmingClear(false)} disabled={clearView.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => clearView.mutate()} disabled={clearView.isPending}>
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {readAll.isError && (
        <p className="text-sm text-red-500">{(readAll.error as Error).message}</p>
      )}
      {rowError && <p className="text-sm text-red-500">{rowError.message}</p>}

      {rows.length === 0 ? (
        <EmptyState
          illustration={
            <InboxIcon className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} />
          }
          title={unreadOnly ? "Nothing unread" : "Nothing here"}
          description="Alerts, approvals and mentions addressed to you land here."
        />
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {rows.map((n) => {
            const inner = (
              <div className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    n.read ? "bg-transparent" : "bg-[var(--primary)]",
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm", !n.read && "font-medium")}>{n.title}</p>
                  {n.body && (
                    <p className="mt-0.5 text-sm text-[var(--text-muted)]">{n.body}</p>
                  )}
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {kindLabel(n.type)} · {when(n.createdAt)}
                  </p>
                </div>
              </div>
            );
            const body = n.url ? (
              <Link
                href={notificationHref(orgSlug, n.url)}
                className="block min-w-0 flex-1"
              >
                {inner}
              </Link>
            ) : (
              <div className="min-w-0 flex-1">{inner}</div>
            );
            // The actions sit beside the link, not inside it, so using them
            // never navigates away from the inbox.
            return (
              <NotificationPreview key={n.id} orgId={orgId} notification={n} side="bottom">
              <div className="group flex items-start hover:bg-[var(--primary-tint)]">
                {body}
                <div className="flex shrink-0 items-center gap-1 px-2 py-2.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={n.read ? `Mark "${n.title}" unread` : `Mark "${n.title}" read`}
                    title={n.read ? "Mark unread" : "Mark read"}
                    disabled={markOne.isPending}
                    onClick={() => markOne.mutate({ id: n.id, read: !n.read })}
                  >
                    {n.read ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Clear "${n.title}"`}
                    title="Clear from inbox"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(n.id)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
              </NotificationPreview>
            );
          })}
        </div>
      )}

      {q.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
        >
          {q.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
    </div>
  );
}
