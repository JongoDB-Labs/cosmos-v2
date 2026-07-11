"use client";
// Foreman decision feed — cursor-paged, filterable by kind. Split out of
// foreman-console.tsx to keep that file focused (see the Task 9 plan).

import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { History, Rocket, PauseCircle, AlertTriangle, Bot, type LucideIcon } from "lucide-react";
import { rel } from "./foreman-console";

// The events API returns full foreman_events rows (orgId, workItemId, data,
// …) — this only types the fields the feed actually renders.
interface ForemanEventRow {
  id: string;
  ts: string;
  ticketKey: string | null;
  kind: string;
  message: string;
}

interface EventsPage {
  events: ForemanEventRow[];
  nextCursor: string | null;
}

type KindFilter = "all" | "shipped" | "parked" | "error";

const FILTERS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "shipped", label: "Ships" },
  { key: "parked", label: "Parked" },
  { key: "error", label: "Errors" },
];

function iconForKind(kind: string): LucideIcon {
  if (kind === "shipped") return Rocket;
  if (kind === "parked" || kind === "gated") return PauseCircle;
  if (kind === "error" || kind === "ship-failed") return AlertTriangle;
  return Bot;
}

export function ForemanEventFeed({ orgId }: { orgId: string }) {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const eventsKey = useOrgQueryKey("foreman-events", kindFilter);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: eventsKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (kindFilter !== "all") p.set("kind", kindFilter);
      if (pageParam) p.set("cursor", pageParam);
      return jsonFetch<EventsPage>(`/api/v1/orgs/${orgId}/foreman/events?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const events = useMemo(() => data?.pages.flatMap((p) => p.events) ?? [], [data]);

  return (
    <SectionCard
      icon={History}
      title="Event feed"
      description="Every decision the daemon has made, newest first."
    >
      <div className="mb-4 flex items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setKindFilter(f.key)}
            aria-pressed={kindFilter === f.key}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              kindFilter === f.key
                ? "border-[var(--primary)] bg-[var(--primary-tint)] font-medium text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--primary-tint)]",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {events.map((e) => {
            const Icon = iconForKind(e.kind);
            return (
              <li key={e.id} className="flex items-start gap-3 py-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[var(--text)]">{e.message}</p>
                  {e.ticketKey && (
                    <span className="font-mono text-xs text-[var(--text-muted)]">{e.ticketKey}</span>
                  )}
                </div>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{rel(e.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {hasNextPage && (
        <div className="flex justify-center pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
