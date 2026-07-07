"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity as ActivityIcon, Star } from "lucide-react";

/**
 * Home-dashboard list widgets (FR 8702c9b8) — "Recent activity" and "My watched
 * items". Each renders a compact feed, spanning the widget grid, and reuses
 * endpoints that already exist (the org activity feed / the work-item search
 * with `watchedByMe`).
 */
export function HomeListWidget({
  orgId,
  orgSlug,
  type,
}: {
  orgId: string;
  orgSlug: string;
  type: "recent_activity" | "my_watched";
}) {
  if (type === "recent_activity") return <RecentActivity orgId={orgId} orgSlug={orgSlug} />;
  return <MyWatched orgId={orgId} orgSlug={orgSlug} />;
}

interface ActivityRow {
  id: string;
  action: string;
  field: string | null;
  createdAt: string;
  actor: { displayName: string };
  item: { id: string; ticketKey: string; title: string } | null;
}

function RecentActivity({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const key = useOrgQueryKey("home", "recent-activity");
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<{ data: ActivityRow[] }>(`/api/v1/orgs/${orgId}/activity?limit=6`),
    staleTime: 30_000,
  });
  const rows = data?.data ?? [];

  return (
    <WidgetShell title="Recent activity" icon={<ActivityIcon className="size-3.5" />} moreHref={`/${orgSlug}/activity`}>
      {isLoading ? (
        <Skeletons />
      ) : isError || rows.length === 0 ? (
        <Empty text="No recent activity" />
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className="text-xs leading-snug">
              <span className="font-medium text-[var(--text)]">{a.actor.displayName}</span>{" "}
              <span className="text-[var(--text-muted)]">
                {a.action === "created" ? "created" : a.field ? `changed ${a.field}` : a.action}
              </span>
              {a.item && (
                <>
                  {" "}
                  <Link
                    href={`/${orgSlug}/issues?item=${a.item.id}`}
                    className="font-medium text-[var(--primary)] hover:underline"
                  >
                    {a.item.ticketKey}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

interface IssueRow {
  id: string;
  ticketKey: string;
  title: string;
  columnKey: string;
}

function MyWatched({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const key = useOrgQueryKey("home", "my-watched");
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<{ data: IssueRow[] }>(
        `/api/v1/orgs/${orgId}/work-items/search?watchedByMe=1&pageSize=6`,
      ),
    staleTime: 30_000,
  });
  const rows = data?.data ?? [];

  return (
    <WidgetShell
      title="My watched items"
      icon={<Star className="size-3.5" />}
      moreHref={`/${orgSlug}/issues?watching=1`}
    >
      {isLoading ? (
        <Skeletons />
      ) : isError || rows.length === 0 ? (
        <Empty text="You're not watching anything yet" />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <Link
                href={`/${orgSlug}/issues?item=${r.id}`}
                className="min-w-0 flex-1 truncate hover:underline"
                title={`${r.ticketKey} · ${r.title}`}
              >
                <span className="mr-1 text-[var(--text-muted)]">{r.ticketKey}</span>
                <span className="text-[var(--text)]">{r.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

function WidgetShell({
  title,
  icon,
  moreHref,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  moreHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          {icon} {title}
        </div>
        <Link href={moreHref} className="text-xs text-[var(--text-muted)] hover:text-[var(--primary)]">
          View all
        </Link>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-4 text-center text-xs text-[var(--text-muted)]">{text}</p>;
}
