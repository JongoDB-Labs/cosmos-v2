"use client";

/** A project's "Filters" tab: the saved filters shared with the project. */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Filter, LayoutDashboard } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { SavedFilter } from "./use-saved-filters";

export function ProjectFilters({
  orgId,
  orgSlug,
  projectId,
  projectKey,
  canCreateBoard = false,
}: {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectKey: string;
  /**
   * May this viewer create a board in THIS project? Derived by the page with
   * `canManageBoardsInProject`, the one derivation the project layout and the
   * POST both use — a second, org-grant-only guess here is how an affordance
   * reappears for someone whose create would 403.
   */
  canCreateBoard?: boolean;
}) {
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
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-[var(--text-muted)]">by {f.ownerName}</span>
            {/* "How do I save a filter as a board?" was asked three times about
                a shipped feature, because both its doors are on the Issues page
                — one a toolbar button acting on the query bar, one buried in a
                dropdown. This tab is where someone looking at their filters
                already is, and it had no actions at all.
                A link, not a button: the Issues deep link already owns the
                dialog, the CQL validation and the project gating, and a second
                copy of that flow is how the two drift apart. */}
            {canCreateBoard && (
              <Link
                href={`/${orgSlug}/issues?filter=${f.id}&saveBoard=1`}
                aria-label={`Save “${f.name}” as board`}
                className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--primary)] hover:underline"
              >
                <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
                Save as board
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
