"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { rel } from "./foreman-console";

/**
 * Foreman's outcome-grooming activity feed — a sibling of ForemanSupervisorPanel
 * (which configures the supervisor) and ForemanEventFeed (which shows the
 * daemon's build decisions). This shows what the *supervisor* did — or, in
 * dry mode, would do — to parked/stuck/duplicate tickets between passes.
 * THIN: GET the rows on mount against /api/v1/orgs/:orgId/foreman/grooming,
 * no pagination, no filters (mirrors the read-only half of the sibling
 * panels; add cursor-paging later if the list grows unwieldy).
 *
 * Dry rows for an actionable proposal get an Apply button that POSTs
 * .../grooming/apply and carries it out; live rows for a reversible action
 * get an Undo button that POSTs .../grooming/undo. Both use useOrgMutation
 * (same pattern as the per-row mutations in foreman-console.tsx) so a
 * failure surfaces via the shared notifyError toast and a success refetches
 * this feed via `invalidate`.
 */
interface GroomingRow {
  id: string;
  ts: string;
  ticketKey: string | null;
  workItemId: string | null;
  action: string;
  evidence: string;
  dupOf: string | null;
  dry: boolean;
  prClosed: boolean | null;
}

interface GroomingResponse {
  rows: GroomingRow[];
}

const ACTION_LABELS: Record<string, string> = {
  "deliver-close": "Deliver & close",
  "dedup-consolidate": "Dedup & consolidate",
  requeue: "Requeue",
  escalate: "Escalate",
};

const ACTION_VARIANTS: Record<string, BadgeVariant> = {
  "deliver-close": "done",
  "dedup-consolidate": "discovery",
  requeue: "progress",
  escalate: "critical",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function actionVariant(action: string): BadgeVariant {
  return ACTION_VARIANTS[action] ?? "neutral";
}

// Actions that involve closing a PR — the only ones where a false `prClosed`
// is worth flagging.
const PR_CLOSING_ACTIONS = new Set(["deliver-close", "dedup-consolidate"]);

// A dry row proposing one of these actions can be carried out via Apply.
const APPLICABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue", "escalate"]);

// A live (already-acted) row for one of these actions can be reversed via
// Undo. Escalate never acts on its own — it just leaves a comment for a
// human — so there's nothing to undo, and an "undo" row is never itself
// re-undoable.
const UNDOABLE_ACTIONS = new Set(["deliver-close", "dedup-consolidate", "requeue"]);

export function ForemanGroomingFeed({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-grooming");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<GroomingResponse>(`/api/v1/orgs/${orgId}/foreman/grooming`),
  });
  // Defensive default — guards against a malformed/short-circuited response
  // (e.g. in tests that don't stub this route) as well as the real API.
  const rows = data?.rows ?? [];

  const apply = useOrgMutation<unknown, Error, string>({
    mutationFn: (workItemId) =>
      jsonFetch<unknown>(`/api/v1/orgs/${orgId}/foreman/grooming/apply`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      }),
    invalidate: [["foreman-grooming"]],
  });

  const undo = useOrgMutation<unknown, Error, string>({
    mutationFn: (workItemId) =>
      jsonFetch<unknown>(`/api/v1/orgs/${orgId}/foreman/grooming/undo`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      }),
    invalidate: [["foreman-grooming"]],
  });

  return (
    <SectionCard
      icon={Activity}
      title="Supervisor activity"
      description="What the supervisor did — or, in dry mode, would do."
    >
      <p className="mb-2 text-xs text-[var(--text-muted)]">
        Dry proposals don&apos;t change anything — click Apply to act on one. Live actions can be
        Undone.
      </p>
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : isError || !data ? (
        <LoadError title="Couldn't load supervisor activity" onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No supervisor activity yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {[...rows]
            .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
            .map((row) => {
              const prCloseFailed = PR_CLOSING_ACTIONS.has(row.action) && row.prClosed === false;
              const canApply = row.dry && !!row.workItemId && APPLICABLE_ACTIONS.has(row.action);
              const canUndo =
                !row.dry &&
                !!row.workItemId &&
                row.action !== "undo" &&
                UNDOABLE_ACTIONS.has(row.action);
              return (
                <li key={row.id} className="flex items-start gap-3 py-2.5">
                  <Badge variant={actionVariant(row.action)}>{actionLabel(row.action)}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.ticketKey ? (
                        <span className="font-mono text-xs text-[var(--text)]">{row.ticketKey}</span>
                      ) : row.workItemId ? (
                        <span className="font-mono text-xs text-[var(--text-muted)]">{row.workItemId}</span>
                      ) : null}
                      {row.dry && (
                        <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                          dry
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-[var(--text-muted)]">{row.evidence}</p>
                    {prCloseFailed && (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--status-blocked-text,var(--status-blocked))]">
                        <AlertTriangle className="size-3" aria-hidden />
                        PR close failed
                      </p>
                    )}
                  </div>
                  {canApply && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={apply.isPending && apply.variables === row.workItemId}
                      onClick={() => apply.mutate(row.workItemId as string)}
                    >
                      Apply
                    </Button>
                  )}
                  {canUndo && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={undo.isPending && undo.variables === row.workItemId}
                      onClick={() => undo.mutate(row.workItemId as string)}
                    >
                      Undo
                    </Button>
                  )}
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{rel(row.ts)}</span>
                </li>
              );
            })}
        </ul>
      )}
    </SectionCard>
  );
}
