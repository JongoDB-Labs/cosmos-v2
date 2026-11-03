"use client";

/**
 * Strategic Roadmap view (ROADMAP board type). Deliberately NOT a Gantt: it's a
 * high-altitude, Jira-Plans-style grid of **Epics (swimlane rows) × Increments
 * (columns)**, with each epic's Features shown as cards in the cell for the PI
 * they're scheduled into, plus a per-epic progress roll-up. Because govcon/SAFe
 * epics+features are placed by *interval/PI assignment* (they rarely carry start/due
 * dates), the time axis is the project's intervals — which is exactly what sets this
 * apart from the date-driven Timeline/Gantt.
 */
import { useBoardQuery } from "@/components/boards/shared/use-board-query";
import { BoardQueryBar } from "@/components/boards/shared/board-query-bar";
import {
  BoardToolbar,
  BoardToolbarActions,
  BoardToolbarMeta,
  BoardToolbarTitle,
  HideDoneToggle,
} from "@/components/boards/shared/board-toolbar";
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Map as MapIcon, Check } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { FilterBar, emptyFilters, type BoardFilters } from "@/components/boards/shared/filter-bar";
import { teamsByUser, type TeamLike } from "@/lib/teams/item-teams";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { useProjectStatuses } from "@/hooks/use-project-statuses";
import { cn } from "@/lib/utils";
import { isWorkItemDone, isWorkItemResolved } from "@/lib/work-items/done-state";
import { highlightLabel, highlightStyle } from "@/lib/work-items/highlights";
import type { WorkItem, OrgMember, Interval, Board, BoardColumn } from "@/types/models";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { useProjectTeams } from "@/hooks/use-project-teams";
import { intervalChildrenById } from "@/lib/intervals/interval-tree";

interface RoadmapViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

const UNSCHEDULED = "__unscheduled__";
const LANE_W = "w-[280px]";
const COL_W = "w-[248px]";

function isEpic(item: WorkItem): boolean {
  return (
    bareTypeKey(item.workItemType?.key) === "EPIC" ||
    (item.workItemType?.name ?? "").toLowerCase() === "epic"
  );
}

/** "Jul–Sep '26"; cross-year → "Dec '26 – Mar '27". */
function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const mon = (d: Date) => d.toLocaleString("en-US", { month: "short" });
  const yy = (d: Date) => String(d.getFullYear()).slice(2);
  return s.getFullYear() === e.getFullYear()
    ? `${mon(s)}–${mon(e)} '${yy(e)}`
    : `${mon(s)} '${yy(s)} – ${mon(e)} '${yy(e)}`;
}

export function RoadmapView({ orgId, projectId, boardId }: RoadmapViewProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const qc = useQueryClient();
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  const teamsKey = useOrgQueryKey("project-teams", projectId);
  const boardKey = useOrgQueryKey("board", boardId);
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const [itemsQ, membersQ, boardQ, intervalsQ, teamsQ] = useQueries({
    queries: [
      { queryKey: itemsKey, queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`) },
      { queryKey: membersKey, queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`) },
      { queryKey: boardKey, queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`) },
      { queryKey: intervalsKey, queryFn: () => jsonFetch<Interval[]>(`${basePath}/intervals`) },
      {
        queryKey: teamsKey,
        queryFn: () =>
          jsonFetch<TeamLike[]>(`${basePath}/teams`),
      },
    ],
  });

  const items: WorkItem[] = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  // The shared filter bar and the ONE shared predicate, same as every other
  // board. Layered on top of whatever the board itself already narrows.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);
  const projectStatuses = useProjectStatuses(orgId, projectId);
  // The Team picker on the detail sheet (COSMOS-204).
  const { data: detailTeams } = useProjectTeams(orgId, projectId);
  // With the query language on, the bar and the board's scope are one CQL query (boards/shared/use-board-query).
  const boardQuery = useBoardQuery({ orgId, projectId, config: boardQ.data?.config, rows: items as unknown as Record<string, unknown>[] });
  const intervals: Interval[] = useMemo(() => intervalsQ.data ?? [], [intervalsQ.data]);
  // A PI selection in the Interval filter means "any sprint under this PI"
  // (3d90c48e). Items carry a sprint id, never a PI id.
  const intervalChildren = useMemo(() => intervalChildrenById(intervals), [intervals]);
  // The team rule needs this map, not just the list: a team's work is the items
  // naming it PLUS its members' items that name no team. Without it the filter
  // is documented as inert, so the control would look like it worked and do
  // nothing (board-filters.ts).
  const teams: TeamLike[] = useMemo(() => teamsQ.data ?? [], [teamsQ.data]);
  const teamsByUserId = useMemo(() => teamsByUser(teams), [teams]);
  const visibleItems = useMemo(
    () =>
      items.filter((it) =>
        boardQuery.enabled
          ? boardQuery.keep(it)
          : matchesFilters(it, filters, [], teamsByUserId, undefined, { intervalChildren }),
      ),
    [items, filters, boardQuery, intervalChildren, teamsByUserId],
  );
  const members: OrgMember[] = membersQ.data ?? [];
  const columns: BoardColumn[] = boardQ.data?.columns ?? [];

  const [detailId, setDetailId] = useState<string | null>(null);
  const detailItem = detailId ? items.find((i) => i.id === detailId) ?? null : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);

  const loading = itemsQ.isLoading || intervalsQ.isLoading || boardQ.isLoading;

  // Column axis: the project's increments (PIs), oldest→newest, then a trailing
  // "Unscheduled" bucket for features with no PI.
  const laneCols = useMemo(() => {
    const sorted = [...intervals].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
    return [
      ...sorted.map((c) => ({ id: c.id, name: c.name, sub: fmtRange(c.startDate, c.endDate) })),
      { id: UNSCHEDULED, name: "Unscheduled", sub: "no increment" },
    ];
  }, [intervals]);

  // Rows: epics (fallback: any parent-of-children if the project has no Epic
  // type). Each row buckets its features by the PI they're scheduled into.
  const rows = useMemo(() => {
    const childrenByParent = new Map<string, WorkItem[]>();
    for (const it of visibleItems) {
      if (!it.parentId) continue;
      const arr = childrenByParent.get(it.parentId) ?? [];
      arr.push(it);
      childrenByParent.set(it.parentId, arr);
    }
    let lanes = visibleItems.filter(isEpic);
    if (lanes.length === 0) {
      lanes = visibleItems.filter((i) => !i.parentId && childrenByParent.has(i.id));
    }
    lanes = [...lanes].sort((a, b) => a.sortOrder - b.sortOrder);

    return lanes.map((epic) => {
      const feats = (childrenByParent.get(epic.id) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      const done = feats.filter((f) => f.completedAt).length;
      const byCol = new Map<string, WorkItem[]>();
      for (const f of feats) {
        const col = f.intervalId ?? epic.intervalId ?? UNSCHEDULED;
        const arr = byCol.get(col) ?? [];
        arr.push(f);
        byCol.set(col, arr);
      }
      return { epic, feats, total: feats.length, done, byCol };
    });
  }, [visibleItems]);

  // Only render PI columns that actually hold a feature somewhere (keeps the grid
  // from sprawling across empty future PIs) — but always keep the real PIs; drop
  // only a fully-empty "Unscheduled" bucket. (React Compiler memoizes this.)
  const usedCols = new Set<string>();
  for (const r of rows) for (const k of r.byCol.keys()) usedCols.add(k);
  const activeCols = laneCols.filter(
    (c) => usedCols.has(c.id) || (c.id !== UNSCHEDULED && intervals.length > 0),
  );

  if (loading) return <RoadmapSkeleton />;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allCollapsed = rows.every((r) => collapsed.has(r.epic.id));

  // What this board can DO, handed to whichever filter surface renders below
  // as its `actions` slot rather than drawn as a `<BoardToolbar>` band of its
  // own. That band's classes are identical to the filter bar's, so a board
  // carrying both drew the same band twice -- see ffe324aa and
  // kanban-board.one-band.test.tsx.
  const boardActions = (
    <>
  <BoardToolbarTitle icon={MapIcon}>Roadmap</BoardToolbarTitle>
  <BoardToolbarMeta>
    {rows.length} epics · {intervals.length} increments
  </BoardToolbarMeta>
  <BoardToolbarActions>
    <HideDoneToggle checked={hideDone} onChange={setHideDone} />
    <button
      onClick={() =>
        setCollapsed(allCollapsed ? new Set() : new Set(rows.map((r) => r.epic.id)))
      }
      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
    >
      {allCollapsed ? "Expand all" : "Collapse all"}
    </button>
  </BoardToolbarActions>
    </>
  );
  return (
    <div className="flex h-full flex-col">
      {boardQuery.enabled ? (
        <BoardQueryBar orgId={orgId} q={boardQuery} actions={boardActions} />
      ) : (
        <FilterBar
          filters={filters}
          onFilterChange={setFilters}
          members={membersQ.data ?? []}
          intervals={intervals}
          teams={teams}
          orgId={orgId}
          boardColumns={projectStatuses}
          actions={boardActions}
        />
      )}

      {/* grid */}
      {rows.length === 0 ? (
        /* The chrome above stays. The branch this replaces kept the filter bar
           for exactly this reason -- "hiding the control that did it strands
           the user on a blank screen with no way back" -- but dropped the
           toolbar, and Hide-done lives there. A roadmap whose every epic is
           done is emptied BY Hide-done, so losing it is a one-way door. */
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={MapIcon}
            title="No epics to roadmap yet"
            description="Create Epic-type work items (with Features under them) and assign them to increments — they'll appear here as strategic swimlanes across your PIs."
          />
        </div>
      ) : (
      <div className="flex-1 overflow-auto">
        <div className="min-w-max">
          {/* column headers */}
          <div className="sticky top-0 z-20 flex border-b border-[var(--border)] bg-[var(--surface)]">
            <div
              className={cn(
                LANE_W,
                "sticky left-0 z-10 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]",
              )}
            >
              Epic
            </div>
            {activeCols.map((col) => (
              <div
                key={col.id}
                className={cn(COL_W, "shrink-0 border-r border-[var(--border)] px-3 py-2")}
              >
                <div className="truncate text-sm font-medium text-[var(--text)]">{col.name}</div>
                <div className="text-[11px] text-[var(--text-muted)]">{col.sub}</div>
              </div>
            ))}
          </div>

          {/* epic rows */}
          {rows.map(({ epic, total, done, byCol }) => {
            const isCollapsed = collapsed.has(epic.id);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const accent = epic.workItemType?.color ?? "var(--primary)";
            return (
              <div key={epic.id} className="flex border-b border-[var(--border)]">
                {/* lane header */}
                <div
                  className={cn(
                    LANE_W,
                    "sticky left-0 z-10 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] px-2 py-2",
                  )}
                  style={{ borderLeft: `3px solid ${accent}` }}
                >
                  <div className="flex items-start gap-1">
                    <button
                      onClick={() => toggle(epic.id)}
                      aria-label={isCollapsed ? "Expand epic" : "Collapse epic"}
                      className="mt-0.5 shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </button>
                    <button
                      onClick={() => setDetailId(epic.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="line-clamp-2 text-sm font-medium text-[var(--text)] hover:underline">
                        {epic.title}
                      </span>
                      <span className="text-[11px] text-[var(--text-muted)]">#{epic.ticketNumber}</span>
                    </button>
                  </div>
                  {/* roll-up */}
                  <div className="mt-1.5 flex items-center gap-2 pl-5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                      <div
                        className="h-full rounded-full bg-[var(--status-ok,#22c55e)]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
                      {done}/{total}
                    </span>
                  </div>
                </div>

                {/* cells */}
                {activeCols.map((col) => {
                  const feats = (byCol.get(col.id) ?? []).filter((f) => !hideDone || !f.completedAt);
                  return (
                    <div
                      key={col.id}
                      className={cn(
                        COL_W,
                        "shrink-0 space-y-1 border-r border-[var(--border)] p-1.5",
                      )}
                    >
                      {isCollapsed
                        ? feats.length > 0 && (
                            <div className="rounded bg-[var(--surface)]/40 px-2 py-1 text-[11px] text-[var(--text-muted)]">
                              {feats.length} feature{feats.length === 1 ? "" : "s"}
                            </div>
                          )
                        : feats.map((f) => (
                            <FeatureCard key={f.id} item={f} columns={columns} onClick={() => setDetailId(f.id)} />
                          ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      )}

      <CardDetailSheet
        statusColumns={projectStatuses}
        item={detailItem}
        open={detailItem !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        orgId={orgId}
        projectId={projectId}
        members={members}
        intervals={intervals}
        teams={detailTeams}
        columns={columns}
        projectItems={items}
        onUpdate={(updated) =>
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            prev?.map((it) => (it.id === updated.id ? updated : it)),
          )
        }
        onDelete={(id) => {
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) => prev?.filter((it) => it.id !== id));
          setDetailId(null);
        }}
        onItemCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
        onOpenItem={(id) => setDetailId(id)}
      />
    </div>
  );
}

function FeatureCard({
  item,
  columns,
  onClick,
}: {
  item: WorkItem;
  columns: readonly BoardColumn[];
  onClick: () => void;
}) {
  // TWO questions, and conflating them is what made this card wrong.
  //
  // The tick means DELIVERED, so it stays on done-ness: a cancelled feature must
  // never show a green check. The strikethrough means SETTLED, which covers work
  // that was given up on too (bug 635be41c).
  //
  // Both now read the board's columns. `done` was `!!item.completedAt` alone,
  // which also missed an item parked in a DONE-category lane with no end date
  // stamped — so the tick and the strike would otherwise disagree on the very
  // same card.
  const done = isWorkItemDone(item, columns);
  const resolved = isWorkItemResolved(item, columns);
  return (
    <button
      onClick={onClick}
      data-highlight={item.highlight ?? undefined}
      // Read-only here: this card has no context menu, so the highlight is set
      // from the detail sheet this button opens (or from any board that does
      // have one) and rendered here.
      style={highlightStyle(item.highlight)}
      title={highlightLabel(item.highlight) ?? undefined}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-left text-xs transition-colors hover:border-[var(--primary)]",
        resolved && "opacity-70",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full",
          done ? "bg-[var(--status-ok,#22c55e)] text-white" : "border border-[var(--border)]",
        )}
      >
        {done && <Check className="size-2.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 text-[var(--text)]", resolved && "line-through")}>
          {item.title}
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">#{item.ticketNumber}</span>
      </span>
    </button>
  );
}

function RoadmapSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <BoardToolbar>
        <Skeleton className="h-6 w-48" />
      </BoardToolbar>
      <div className="flex-1 space-y-2 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
