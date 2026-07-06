"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Activity as ActivityIcon } from "lucide-react";

interface FeedItem {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  actor: { id: string; displayName: string; avatarUrl: string | null };
  item: {
    id: string;
    ticketKey: string;
    ticketNumber: number;
    title: string;
    columnKey: string;
    project: { id: string; key: string; name: string };
    type: { id: string; name: string; icon: string | null; color: string | null };
  } | null;
}

interface FeedPage {
  data: FeedItem[];
  nextCursor: string | null;
}

interface Facets {
  projects: { id: string; key: string; name: string; archived: boolean }[];
  types: { id: string; key: string; name: string }[];
  members: { id: string; displayName: string }[];
}

const ANY = "__any__";
const ACTIONS = ["created", "updated", "commented", "deleted"];

/** Human-readable phrasing for an activity row. */
function phrase(a: FeedItem): React.ReactNode {
  if (a.action === "created") return "created this item";
  if (a.action === "commented") return "commented";
  if (a.action === "deleted") return "deleted this item";
  if (a.action === "updated" && a.field) {
    return (
      <>
        changed <span className="font-medium text-[var(--text)]">{a.field}</span>
        {a.oldValue && (
          <>
            {" "}from <span className="text-[var(--text-muted)] line-through">{a.oldValue}</span>
          </>
        )}
        {a.newValue && (
          <>
            {" "}to <span className="font-medium text-[var(--text)]">{a.newValue}</span>
          </>
        )}
      </>
    );
  }
  return a.action;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The org-wide "latest updates" feed (FR 8aa3c0e0). Reverse-chron work-item
 * activity, filterable by project / type / action / person, cursor-paginated.
 * Filter options come from the shared work-items facets endpoint (already
 * project-scoped to what the actor can read).
 */
export function UpdatesFeed({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const [projectId, setProjectId] = useState(ANY);
  const [typeId, setTypeId] = useState(ANY);
  const [action, setAction] = useState(ANY);
  const [userId, setUserId] = useState(ANY);

  // Share the Issues view's facets cache (same endpoint, project-scoped).
  const facetsKey = useOrgQueryKey("issues", "facets");
  const { data: facets } = useQuery({
    queryKey: facetsKey,
    queryFn: () => jsonFetch<Facets>(`/api/v1/orgs/${orgId}/work-items/facets`),
    staleTime: 60_000,
  });

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectId !== ANY) p.set("projectId", projectId);
    if (typeId !== ANY) p.set("type", typeId);
    if (action !== ANY) p.set("action", action);
    if (userId !== ANY) p.set("userId", userId);
    return p.toString();
  }, [projectId, typeId, action, userId]);

  const feedKey = useOrgQueryKey("updates", qs);
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: feedKey,
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) => {
        const p = new URLSearchParams(qs);
        if (pageParam) p.set("cursor", pageParam);
        return jsonFetch<FeedPage>(`/api/v1/orgs/${orgId}/activity?${p.toString()}`);
      },
      getNextPageParam: (last) => last.nextCursor,
    });

  const items = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);

  // Group consecutive items under their day header.
  const groups = useMemo(() => {
    const out: { day: string; rows: FeedItem[] }[] = [];
    for (const it of items) {
      const day = dayLabel(it.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(it);
      else out.push({ day, rows: [it] });
    }
    return out;
  }, [items]);

  const projects = (facets?.projects ?? []).filter((p) => !p.archived);

  return (
    <div className="mx-auto max-w-4xl">
      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterSelect
          label="All projects"
          value={projectId}
          onChange={setProjectId}
          options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
          ariaLabel="Filter by project"
        />
        <FilterSelect
          label="All types"
          value={typeId}
          onChange={setTypeId}
          options={(facets?.types ?? []).map((t) => ({ value: t.id, label: t.name }))}
          ariaLabel="Filter by type"
        />
        <FilterSelect
          label="Any action"
          value={action}
          onChange={setAction}
          options={ACTIONS.map((a) => ({ value: a, label: a.charAt(0).toUpperCase() + a.slice(1) }))}
          ariaLabel="Filter by action"
        />
        <FilterSelect
          label="Anyone"
          value={userId}
          onChange={setUserId}
          options={(facets?.members ?? []).map((m) => ({ value: m.id, label: m.displayName }))}
          ariaLabel="Filter by person"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={ActivityIcon}
          title="Couldn't load updates"
          description="Something went wrong fetching the activity feed. Try again shortly."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title="No updates yet"
          description="Work-item changes across your projects will show up here as they happen."
        />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.day}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {g.day}
              </h3>
              <ul className="space-y-2.5">
                {g.rows.map((a) => (
                  <li key={a.id} className="flex items-start gap-3">
                    <Avatar className="mt-0.5 h-7 w-7 shrink-0">
                      <AvatarImage src={a.actor.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-[10px]">
                        {a.actor.displayName.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="font-medium text-[var(--text)]">
                        {a.actor.displayName}
                      </span>{" "}
                      <span className="text-[var(--text-muted)]">{phrase(a)}</span>
                      {a.item && (
                        <>
                          {" "}on{" "}
                          <Link
                            href={`/${orgSlug}/issues?item=${a.item.id}`}
                            className="font-medium text-[var(--primary)] hover:underline"
                          >
                            {a.item.ticketKey}
                          </Link>{" "}
                          <span className="text-[var(--text-muted)]">{a.item.title}</span>
                        </>
                      )}
                    </div>
                    <time className="shrink-0 text-xs text-[var(--text-muted)]" dateTime={a.createdAt}>
                      {timeLabel(a.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {hasNextPage && (
            <div className="flex justify-center pt-2">
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
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as string)}>
      <SelectTrigger size="sm" aria-label={ariaLabel} className="h-8 w-auto min-w-36 text-xs">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{label}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
