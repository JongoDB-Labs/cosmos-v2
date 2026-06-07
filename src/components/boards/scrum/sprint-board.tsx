"use client";

import { useEffect, useMemo, useState } from "react";
import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Target, CalendarDays } from "lucide-react";
import type { Cycle } from "@/types/models";

interface SprintBoardProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

type CycleWithCount = Cycle & { _count?: { workItems: number } };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A SCRUM board = the proven Kanban scoped to the active sprint, with a sprint
 * context header (name, goal, dates, days remaining, progress). The Kanban is
 * seeded with the active sprint via `initialCycleId`; the user can still widen
 * the scope from the board's filter bar.
 */
export function SprintBoard({
  orgId,
  projectId,
  projectKey,
  boardId,
}: SprintBoardProps) {
  const [cycles, setCycles] = useState<CycleWithCount[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/cycles`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: CycleWithCount[]) => {
        if (!cancelled) setCycles(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setCycles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, projectId]);

  const active = useMemo(() => pickActiveSprint(cycles ?? []), [cycles]);

  return (
    <div className="flex h-full flex-col">
      {cycles === null ? (
        <div className="border-b border-[var(--border)] px-6 py-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-2 h-3 w-72" />
        </div>
      ) : active ? (
        <SprintHeader sprint={active} />
      ) : (
        <div className="border-b border-[var(--border)] px-6 py-3 text-sm text-[var(--text-muted)]">
          No active sprint — showing the full board. Create a sprint in the{" "}
          <span className="font-medium text-[var(--text)]">Cycles</span> tab to
          plan one.
        </div>
      )}

      <div className="min-h-0 flex-1">
        <KanbanBoard
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
          initialCycleId={active?.id}
        />
      </div>
    </div>
  );
}

function SprintHeader({ sprint }: { sprint: CycleWithCount }) {
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
    </div>
  );
}

function statusBadge(status: Cycle["status"]): {
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
 * considers SPRINT-kind cycles when any exist (a SCRUM board is sprint-driven),
 * otherwise falls back to any cycle.
 */
function pickActiveSprint(cycles: CycleWithCount[]): CycleWithCount | null {
  if (!cycles.length) return null;
  const sprints = cycles.filter((c) => c.cycleKind === "SPRINT");
  const pool = sprints.length ? sprints : cycles;
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
