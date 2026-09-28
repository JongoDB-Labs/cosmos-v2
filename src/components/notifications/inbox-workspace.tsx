"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { Inbox as InboxIcon } from "lucide-react";

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
  read: boolean;
  createdAt: string;
};

type Page = {
  data: Row[];
  nextCursor: string | null;
  counts: { total: number; unread: number; byType: { type: string; count: number }[] };
};

/** A dotted type reads as its last word — `x.y.past_due` becomes "Past due" —
 *  so a new kind needs no lookup table, and no table can go stale. */
export function kindLabel(type: string): string {
  const leaf = type.split(".").pop() ?? type;
  const words = leaf.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function InboxWorkspace({ orgId }: { orgId: string }) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org"] }),
  });

  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts;

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
          ? "border-transparent bg-[var(--accent)] text-white"
          : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
      )}
    >
      {label}
      {n !== undefined && <span className="ml-1.5 tabular-nums opacity-70">{n}</span>}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {chip(null, "Everything", counts?.total)}
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
        </div>
      </div>

      {readAll.isError && (
        <p className="text-sm text-red-500">{(readAll.error as Error).message}</p>
      )}

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
                    n.read ? "bg-transparent" : "bg-[var(--accent)]",
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
            return n.url ? (
              <Link
                key={n.id}
                href={n.url.startsWith("/") ? `/${orgSlug}${n.url}` : n.url}
                className="block hover:bg-[var(--primary-tint)]"
              >
                {inner}
              </Link>
            ) : (
              <div key={n.id}>{inner}</div>
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
