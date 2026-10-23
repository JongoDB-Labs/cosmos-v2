"use client";

/** A project's "Filters" tab: the saved filters shared with the project. */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { SavedFilter } from "./use-saved-filters";

export function ProjectFilters({ orgId, orgSlug, projectId, projectKey }: { orgId: string; orgSlug: string; projectId: string; projectKey: string }) {
  const { data, isLoading } = useQuery({
    queryKey: useOrgQueryKey("saved-views", "project", projectId),
    queryFn: () => jsonFetch<SavedFilter[]>(`/api/v1/orgs/${orgId}/saved-views?projectId=${projectId}`),
  });
  if (isLoading) return <div className="h-24 animate-pulse rounded-[var(--radius)] border border-[var(--border)]" />;
  if (!data?.length) {
    return (
      <EmptyState
        illustration={<Filter className="mx-auto h-10 w-10 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
        title="No filters shared with this project"
        description={`On Issues, save a filter and choose "A project" → ${projectKey} to share it here.`}
      />
    );
  }
  return (
    <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]" aria-label="Project filters">
      {data.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Link href={`/${orgSlug}/issues?filter=${f.id}`} className="font-medium text-[var(--primary)] hover:underline">
              {f.name}
            </Link>
            {f.description && <p className="truncate text-xs text-[var(--text-muted)]">{f.description}</p>}
          </div>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">by {f.ownerName}</span>
        </li>
      ))}
    </ul>
  );
}
