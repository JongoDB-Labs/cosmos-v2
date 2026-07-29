"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Target, CalendarDays, Plus, ListChecks } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { IntervalsWorkspace } from "@/components/intervals/intervals-workspace";
import { cn } from "@/lib/utils";
import type { Interval } from "@/types/models";

interface SprintBoardProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

type IntervalWithCount = Interval & { _count?: { workItems: number } };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A SCRUM board = the proven Kanban scoped to the active sprint, with a sprint
 * context header (name, goal, dates, days remaining, progress). The Kanban is
 * seeded with the active sprint via `initialIntervalId`; the user can still widen
 * the scope from the board's filter bar.
 */
export function SprintBoard({
  orgId,
  projectId,
  projectKey,
  boardId,
}: SprintBoardProps) {
  const [intervals, setIntervals] = useState<IntervalWithCount[] | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  // The sprint the board is scoped to. Three distinct states, and they must stay
  // distinct: `undefined` = nothing picked yet, so fall back to the auto-picked
  // active sprint; `null` = the user explicitly chose "All items"; a string = that
  // sprint. Collapsing undefined and null would make "All items" snap straight
  // back to the active sprint.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const intervalsHref = `/${orgSlug}/projects/${projectKey}/intervals`;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/intervals`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: IntervalWithCount[]) => {
        if (!cancelled) setIntervals(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setIntervals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, projectId]);

  const active = useMemo(() => pickActiveSprint(intervals ?? []), [intervals]);

  // What the board is actually showing: the user's pick, else the auto-picked
  // active sprint. Resolved against the loaded list so a stale id (a sprint that
  // was deleted, or a filter-bar interval from another project) falls back
  // rather than blanking the header.
  const shown = useMemo(() => {
    if (selectedId === null) return null; // "All items"
    // A stale id (sprint deleted since) falls back to the active sprint rather
    // than leaving the header blank over a board that is still showing rows.
    if (selectedId) return intervals?.find((c) => c.id === selectedId) ?? active;
    return active;
  }, [selectedId, intervals, active]);

  // Stable identity — KanbanBoard has this in an effect dependency list, so a
  // fresh function each render would re-fire it every time.
  const handleIntervalChange = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {intervals === null ? (
        <div className="border-b border-[var(--border)] px-6 py-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-2 h-3 w-72" />
        </div>
      ) : shown ? (
        <SprintHeader sprint={shown} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-6 py-3">
          <p className="text-sm text-[var(--text-muted)]">
            No active sprint — showing the full board. Create one to start
            planning into time-boxed iterations.
          </p>
          <Link
            href={intervalsHref}
            className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
          >
            <Plus className="h-3.5 w-3.5" /> New sprint
          </Link>
        </div>
      )}

      {/* All sprints — click any to SCOPE THE BOARD to it. These used to open a
          read-only modal, which meant the one obvious way to move between
          sprints didn't move the board at all; the details they showed now live
          in the header above, which follows the selection. */}
      {intervals && intervals.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-6 py-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Sprints
          </span>
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="mr-1 inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--primary-tint)] hover:text-[var(--primary)]"
            title="Create, start, and complete sprints"
          >
            <ListChecks className="h-3 w-3" /> Manage
          </button>
          {(intervals.some((c) => c.intervalKind === "SPRINT")
            ? intervals.filter((c) => c.intervalKind === "SPRINT")
            : intervals
          )
            .slice()
            .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
            .map((c) => {
              const isShown = c.id === shown?.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={isShown}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-[var(--primary-tint)]",
                    isShown
                      ? "border-[var(--primary)] bg-[var(--primary-tint)] font-medium text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-muted)]",
                  )}
                  title={`Show ${c.name || `Sprint ${c.number}`}`}
                >
                  {c.name || `Sprint ${c.number}`}
                </button>
              );
            })}
          {/* Escape hatch back to every item, matching the filter bar's "all
              intervals" state — otherwise, once a pill is picked there is no way
              back to the unscoped board from this row. */}
          <button
            type="button"
            aria-pressed={shown == null}
            onClick={() => setSelectedId(null)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-[var(--primary-tint)]",
              shown == null
                ? "border-[var(--primary)] bg-[var(--primary-tint)] font-medium text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-muted)]",
            )}
            title="Show every item, regardless of sprint"
          >
            All items
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {/* Gate the Kanban mount until intervals resolve. The board seeds its
            sprint scope ONCE, from initialIntervalId in a useState initializer
            (kanban-board.tsx) — so mounting before the active sprint is known
            would pass initialIntervalId=undefined and the board would show every
            item, never re-scoping when the sprint resolves a tick later. Waiting
            for the fetch means a SCRUM board opens already focused on its active
            sprint. (intervals===null only on the very first load; the fetch always
            resolves to an array, so this can't hang.) */}
        {intervals === null ? (
          <KanbanBoardMountSkeleton />
        ) : (
          <KanbanBoard
            orgId={orgId}
            projectId={projectId}
            projectKey={projectKey}
            boardId={boardId}
            initialIntervalId={shown?.id}
            onIntervalChange={handleIntervalChange}
          />
        )}
      </div>

      {/* Manage-sprints drawer — the full sprint lifecycle (create/start/complete)
          without leaving the board. Embeds the same IntervalsWorkspace as the
          top-level Sprints page. */}
      <Sheet open={manageOpen} onOpenChange={setManageOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-4xl"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Manage sprints</SheetTitle>
          </SheetHeader>
          <IntervalsWorkspace
            orgId={orgId}
            projectId={projectId}
            projectKey={projectKey}
          />
        </SheetContent>
      </Sheet>

    </div>
  );
}

/** Column skeleton shown while the intervals fetch resolves (so the Kanban can
 *  mount already seeded with the active sprint — see the gate above). */
function KanbanBoardMountSkeleton() {
  return (
    <div className="flex gap-3 overflow-x-auto p-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="w-72 shrink-0 space-y-3">
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          {i < 2 && <Skeleton className="h-24 w-full rounded-lg" />}
        </div>
      ))}
    </div>
  );
}

function SprintHeader({ sprint }: { sprint: IntervalWithCount }) {
  const start = new Date(sprint.startDate);
  const end = new Date(sprint.endDate);
  const now = new Date();

  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS));
  const elapsedDays = Math.min(
    totalDays,
    Math.max(0, Math.round((now.getTime() - start.getTime()) / DAY_MS)),
  );
  const daysRemaining = Math.max(
    0,
    Math.ceil((end.getTime() - now.getTime()) / DAY_MS),
  );
  const pct = Math.round((elapsedDays / totalDays) * 100);

  const { label: statusLabel, variant } = statusBadge(sprint.status);
  const itemCount = sprint._count?.workItems;
  const report = sprint.report as {
    velocity?: number;
    completedStoryPoints?: number;
    completedItems?: number;
    incompleteItems?: number;
  } | null;

  const dateFmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div className="border-b border-[var(--border)] px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-[var(--text)]">
          {sprint.name || `Sprint ${sprint.number}`}
        </h2>
        <Badge variant={variant} showDot={false}>
          {statusLabel}
        </Badge>
        <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          <CalendarDays className="h-3.5 w-3.5" />
          {dateFmt(start)} – {dateFmt(end)}
        </span>
        {sprint.status === "ACTIVE" && (
          <span className="text-xs text-[var(--text-muted)]">
            · {daysRemaining} day{daysRemaining === 1 ? "" : "s"} left
          </span>
        )}
        {typeof itemCount === "number" && (
          <span className="text-xs text-[var(--text-muted)]">
            · {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {sprint.goal ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-sm text-[var(--text-muted)]">
          <Target className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{sprint.goal}</span>
        </p>
      ) : null}

      {sprint.status === "ACTIVE" && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            Day {elapsedDays} of {totalDays}
          </p>
        </div>
      )}

      {/* Close-out numbers for a finished sprint. These used to live only in the
          per-sprint modal that the pills opened; the pills now scope the board,
          so the report follows the selection into the header instead of being
          lost with the modal. */}
      {report && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-[var(--surface)] p-2 text-xs text-[var(--text-muted)]">
          <span>
            Velocity:{" "}
            <span className="font-medium text-[var(--text)]">
              {report.velocity ?? report.completedStoryPoints ?? 0} pts
            </span>
          </span>
          <span>
            Completed:{" "}
            <span className="font-medium text-[var(--text)]">
              {report.completedItems ?? 0}
            </span>
          </span>
          <span>
            Carried over:{" "}
            <span className="font-medium text-[var(--text)]">
              {report.incompleteItems ?? 0}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function statusBadge(status: Interval["status"]): {
  label: string;
  variant: "progress" | "done" | "neutral";
} {
  switch (status) {
    case "ACTIVE":
      return { label: "Active", variant: "progress" };
    case "COMPLETED":
      return { label: "Completed", variant: "done" };
    default:
      return { label: "Planned", variant: "neutral" };
  }
}

/**
 * Pick the sprint to focus: prefer an ACTIVE one, else one whose date range
 * brackets today, else the next upcoming PLANNED, else the most recent. Only
 * considers SPRINT-kind intervals when any exist (a SCRUM board is sprint-driven),
 * otherwise falls back to any interval.
 */
function pickActiveSprint(intervals: IntervalWithCount[]): IntervalWithCount | null {
  if (!intervals.length) return null;
  const sprints = intervals.filter((c) => c.intervalKind === "SPRINT");
  const pool = sprints.length ? sprints : intervals;
  const now = Date.now();

  const activeStatus = pool.find((c) => c.status === "ACTIVE");
  if (activeStatus) return activeStatus;

  const bracketing = pool.find(
    (c) =>
      new Date(c.startDate).getTime() <= now &&
      new Date(c.endDate).getTime() >= now,
  );
  if (bracketing) return bracketing;

  const upcoming = pool
    .filter((c) => new Date(c.startDate).getTime() > now)
    .sort(
      (a, b) =>
        new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
  if (upcoming[0]) return upcoming[0];

  return [...pool].sort(
    (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime(),
  )[0];
}
