"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Compass, Flag, Target } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { groupObjectivesByInterval, type PanelInterval, type PanelObjective } from "@/lib/goals/objective-grouping";

/**
 * Objectives and interval goals, alongside the project's Goals.
 *
 * These are three different records that all answer "what are we trying to
 * achieve" and used to live on three different screens: Goals on this board,
 * Objectives on the OKR board, and a sprint's goal buried in its interval
 * settings. Nothing here duplicates them — objectives are read from the same
 * objectives API the OKR board writes, and a sprint goal is the interval's own
 * `goal` field, shown read-only where it belongs rather than copied.
 */
export function ObjectivesPanel({
  orgId,
  projectId,
}: {
  orgId: string;
  projectId: string;
}) {
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const objectivesKey = useOrgQueryKey("objectives", projectId);
  const intervalsKey = useOrgQueryKey("intervals", projectId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [objectivesQ, intervalsQ] = useQueries({
    queries: [
      {
        queryKey: objectivesKey,
        queryFn: () => jsonFetch<PanelObjective[]>(`${base}/objectives`),
      },
      {
        queryKey: intervalsKey,
        queryFn: () => jsonFetch<PanelInterval[]>(`${base}/intervals`),
      },
    ],
  });

  const objectives = useMemo(() => objectivesQ.data ?? [], [objectivesQ.data]);
  const intervals = useMemo(() => intervalsQ.data ?? [], [intervalsQ.data]);

  const groups = useMemo(
    () => groupObjectivesByInterval(objectives, intervals),
    [objectives, intervals],
  );

  // OKR_READ / SPRINT_READ may be denied independently of GOAL_READ. EITHER
  // failing hides the panel rather than breaking the Goals board around it.
  //
  // `||`, not `&&`: with OKR_READ but not SPRINT_READ the objectives load and the
  // intervals don't, so every group would resolve to "Unknown interval" — the
  // same dishonest label this release removes from the activity feed. A panel
  // that can't name the timebox an objective belongs to isn't worth showing.
  if (objectivesQ.isError || intervalsQ.isError) return null;

  if (objectivesQ.isLoading || intervalsQ.isLoading) {
    return (
      <section className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }

  if (groups.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Objectives
      </h2>

      {groups.map((group) => {
        const isCollapsed = !!collapsed[group.key];
        return (
          <div key={group.key} className="rounded-lg border border-[var(--border)]">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
              }
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface)]"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              )}
              <Compass className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="text-sm font-medium">{group.label}</span>
              <span className="text-xs text-[var(--text-muted)]">
                {group.objectives.length}
                {group.objectives.length === 1 ? " objective" : " objectives"}
              </span>
              {group.committedCount > 0 && (
                <Badge variant="progress" showDot={false} className="ml-auto text-[10px]">
                  {group.committedCount} committed
                </Badge>
              )}
            </button>

            {!isCollapsed && (
              <div className="space-y-px border-t border-[var(--border)]">
                {/* The interval's own goal — a sprint goal / PI theme. Read-only
                    here: it belongs to the interval, and is edited where the
                    interval is. Showing it means the timebox's headline sits
                    with the objectives committed to it. */}
                {group.intervalGoal && (
                  <p className="flex items-start gap-1.5 bg-[var(--surface)]/60 px-3 py-2 text-xs text-[var(--text-muted)]">
                    <Target className="mt-0.5 size-3.5 shrink-0" />
                    <span>{group.intervalGoal}</span>
                  </p>
                )}

                {group.objectives.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 px-3 py-2">
                    <Flag
                      className={cn(
                        "size-3.5 shrink-0",
                        o.committed ? "text-[var(--primary)]" : "text-[var(--text-muted)]",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{o.title}</span>
                    {!o.committed && (
                      // Only stretch is called out. Labelling both would make the
                      // common case noisy, and committed is the default.
                      <Badge variant="neutral" showDot={false} className="text-[10px]">
                        Stretch
                      </Badge>
                    )}
                    <span className="w-10 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)]">
                      {o.progress}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
