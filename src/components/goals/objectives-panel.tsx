"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Compass, Flag, Plus, Target } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 *
 * Objectives are CREATED here too, not only on the OKR board. This panel was
 * deliberately read-only on the reasoning that objectives are "authored on the
 * OKR board" — but the OKR View board is an optional board type a project may
 * never add, so on those projects there was no way to create an objective at
 * all while this panel sat there describing them. Both screens now post to the
 * same `/objectives` endpoint and share one React Query cache key, so there is
 * one Objective record and either screen sees the other's writes immediately —
 * rather than two boards showing two unrelated datasets, which is the defect
 * already fixed for milestones.
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

  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newIntervalId, setNewIntervalId] = useState("");
  const [newCommitted, setNewCommitted] = useState(true);

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

  // Invalidating "objectives" refreshes the OKR board too — it reads the same
  // key. `intervalId` is omitted rather than sent empty: the route rejects an
  // interval from another project, and "" is not a valid one.
  const createObjective = useOrgMutation({
    mutationFn: () =>
      jsonFetch<PanelObjective>(`${base}/objectives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          status: "ACTIVE",
          committed: newCommitted,
          ...(newIntervalId ? { intervalId: newIntervalId } : {}),
        }),
      }),
    invalidate: [["objectives", projectId]],
    onSuccess: () => {
      setNewTitle("");
      setNewIntervalId("");
      setNewCommitted(true);
      setShowAdd(false);
    },
  });

  function submitNewObjective() {
    if (!newTitle.trim() || createObjective.isPending) return;
    createObjective.mutate(undefined);
  }

  function cancelNewObjective() {
    setShowAdd(false);
    setNewTitle("");
    setNewIntervalId("");
    setNewCommitted(true);
  }

  // The header keeps its create button in every state below — empty, populated
  // and mid-create — so the affordance never disappears once described.
  const header = (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Objectives
      </h2>
      {!showAdd && (
        <Button
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setShowAdd(true)}
        >
          <Plus className="size-3.5" />
          New objective
        </Button>
      )}
    </div>
  );

  const addForm = showAdd && (
    <div className="space-y-2 rounded-lg border border-dashed border-[var(--border)] p-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Objective title..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitNewObjective();
            if (e.key === "Escape") cancelNewObjective();
          }}
          autoFocus
        />
        <Button
          onClick={submitNewObjective}
          disabled={createObjective.isPending || !newTitle.trim()}
        >
          {createObjective.isPending ? "Adding..." : "Add"}
        </Button>
        <Button variant="ghost" onClick={cancelNewObjective}>
          Cancel
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Interval"
          value={newIntervalId}
          onChange={(e) => setNewIntervalId(e.target.value)}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs"
        >
          <option value="">— Not in an interval —</option>
          {intervals.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="accent-[var(--primary)]"
            checked={!newCommitted}
            onChange={(e) => setNewCommitted(!e.target.checked)}
          />
          Uncommitted (stretch)
        </label>
      </div>
    </div>
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

  // Previously `return null`, which made the whole feature invisible until an
  // objective happened to exist — so on a project with none there was no sign it
  // was there, and no hint where objectives are authored. Say so instead.
  //
  // The copy no longer sends the reader to the OKR View board: there is a button
  // right here now, and that board is optional. It describes what an interval
  // buys you, and mentions the OKR board only as the other place the SAME
  // objectives appear.
  if (groups.length === 0) {
    return (
      <section className="space-y-2">
        {header}
        {addForm}
        {!showAdd && (
          <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--text-muted)]">
            No objectives yet. Add one with{" "}
            <span className="font-medium">New objective</span> — give it an interval
            and it appears here grouped by that interval, with committed and stretch
            shown separately. The same objectives show on the OKR View board, where
            you can add key results to them.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {header}
      {addForm}

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
