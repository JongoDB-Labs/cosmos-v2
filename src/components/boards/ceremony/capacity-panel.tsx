"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { isOverCommitted, unitAbbrev } from "@/lib/intervals/sprint-planning";
import type { CapacityUnit } from "@/lib/intervals/sprint-planning";

interface PlanningPayload {
  unit: CapacityUnit;
  goal: string;
  committed: { total: number; itemCount: number };
  current: Record<string, number>;
  suggestions: Record<string, number>;
  defaultCapacity: number;
}

/**
 * Committed scope against the team's capacity for the sprint.
 *
 * Both numbers already exist — `IntervalCapacity` rows and the planning
 * endpoint — but until now they were reachable only from the Start Sprint
 * dialog, which is closed by the time anyone wants to look.
 */
export function CapacityPanel({
  orgId,
  projectId,
  intervalId,
}: {
  orgId: string;
  projectId: string;
  intervalId: string;
}) {
  const key = useOrgQueryKey("interval-planning", intervalId);
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<PlanningPayload>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/intervals/${intervalId}/planning`
      ),
  });

  if (isLoading) return <Skeleton className="h-40" />;
  if (isError || !data) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Capacity is unavailable for this sprint.
      </p>
    );
  }

  const capacity = Object.values(data.current).reduce((s, n) => s + n, 0);
  const over = isOverCommitted(data.committed.total, capacity);
  const abbrev = unitAbbrev(data.unit);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="Team capacity" value={`${capacity} ${abbrev}`} />
        <Figure
          label="Committed"
          value={`${data.committed.total} ${abbrev}`}
          detail={`${data.committed.itemCount} items`}
        />
        <Figure
          label="Headroom"
          value={`${capacity - data.committed.total} ${abbrev}`}
          detail={over ? "Over-committed" : "Within capacity"}
          tone={over ? "warn" : "ok"}
        />
      </div>

      {capacity === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No per-member capacity has been recorded for this sprint, so headroom
          reads as negative. Set it from the sprint&apos;s capacity dialog.
        </p>
      ) : null}

      {data.goal ? (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Sprint goal
          </p>
          <p className="mt-1 text-sm">{data.goal}</p>
        </div>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail ? (
        <p
          className="mt-0.5 text-xs"
          style={{
            color:
              tone === "warn"
                ? "var(--status-critical-text, var(--status-critical))"
                : "var(--text-muted)",
          }}
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}
