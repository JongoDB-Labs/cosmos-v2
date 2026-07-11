"use client";

/**
 * Strategic Roadmap view (ROADMAP board type). Deliberately NOT a Gantt: it's a
 * high-altitude, Jira-Plans-style grid of **Epics (swimlane rows) × Increments
 * (columns)**, with each epic's Features shown as cards in the cell for the PI
 * they're scheduled into, plus a per-epic progress roll-up. Because govcon/SAFe
 * epics+features are placed by *cycle/PI assignment* (they rarely carry start/due
 * dates), the time axis is the project's cycles — which is exactly what sets this
 * apart from the date-driven Timeline/Gantt.
 */
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Map as MapIcon, Check, UserCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useCurrentUserId } from "@/lib/hooks/use-current-user";
import { isAssignedTo } from "@/lib/boards/assignment";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember, Cycle, Board, BoardColumn } from "@/types/models";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";

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
  const boardKey = useOrgQueryKey("board", boardId);
  const cyclesKey = useOrgQueryKey("cycles", projectId);

  const [itemsQ, membersQ, boardQ, cyclesQ] = useQueries({
    queries: [
      { queryKey: itemsKey, queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`) },
      { queryKey: membersKey, queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`) },
      { queryKey: boardKey, queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`) },
      { queryKey: cyclesKey, queryFn: () => jsonFetch<Cycle[]>(`${basePath}/cycles`) },
    ],
  });

  const items: WorkItem[] = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const members: OrgMember[] = membersQ.data ?? [];
  const columns: BoardColumn[] = boardQ.data?.columns ?? [];
  const cycles: Cycle[] = useMemo(() => cyclesQ.data ?? [], [cyclesQ.data]);

  const currentUserId = useCurrentUserId();
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailItem = detailId ? items.find((i) => i.id === detailId) ?? null : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);
  // "Assigned to me" (COSMOS-51): narrow the roadmap to the current user. An epic
  // lane stays visible when the epic itself is assigned to me OR it still has a
  // feature assigned to me; its cells show only my features. Combines with
  // "Hide done" (applied per-cell at render time).
  const [assignedToMe, setAssignedToMe] = useState(false);
  const mineOnly = assignedToMe && currentUserId !== null;

  const loading = itemsQ.isLoading || cyclesQ.isLoading || boardQ.isLoading;

  // Column axis: the project's increments (PIs), oldest→newest, then a trailing
  // "Unscheduled" bucket for features with no PI.
  const laneCols = useMemo(() => {
    const sorted = [...cycles].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
    return [
      ...sorted.map((c) => ({ id: c.id, name: c.name, sub: fmtRange(c.startDate, c.endDate) })),
      { id: UNSCHEDULED, name: "Unscheduled", sub: "no increment" },
    ];
  }, [cycles]);

  // Rows: epics (fallback: any parent-of-children if the project has no Epic
  // type). Each row buckets its features by the PI they're scheduled into.
  const rows = useMemo(() => {
    const childrenByParent = new Map<string, WorkItem[]>();
    for (const it of items) {
      if (!it.parentId) continue;
      const arr = childrenByParent.get(it.parentId) ?? [];
      arr.push(it);
      childrenByParent.set(it.parentId, arr);
    }
    let lanes = items.filter(isEpic);
    if (lanes.length === 0) {
      lanes = items.filter((i) => !i.parentId && childrenByParent.has(i.id));
    }
    lanes = [...lanes].sort((a, b) => a.sortOrder - b.sortOrder);

    const me = currentUserId;
    const built = lanes.map((epic) => {
      let feats = (childrenByParent.get(epic.id) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      if (mineOnly && me) feats = feats.filter((f) => isAssignedTo(f, me));
      const done = feats.filter((f) => f.completedAt).length;
      const byCol = new Map<string, WorkItem[]>();
      for (const f of feats) {
        const col = f.cycleId ?? epic.cycleId ?? UNSCHEDULED;
        const arr = byCol.get(col) ?? [];
        arr.push(f);
        byCol.set(col, arr);
      }
      return { epic, feats, total: feats.length, done, byCol };
    });

    // Under "Assigned to me", drop lanes with no feature of mine — unless the
    // epic itself is assigned to me (keep it visible for context).
    return mineOnly && me
      ? built.filter((r) => r.feats.length > 0 || isAssignedTo(r.epic, me))
      : built;
  }, [items, mineOnly, currentUserId]);

  // Only render PI columns that actually hold a feature somewhere (keeps the grid
  // from sprawling across empty future PIs) — but always keep the real PIs; drop
  // only a fully-empty "Unscheduled" bucket. (React Compiler memoizes this.)
  const usedCols = new Set<string>();
  for (const r of rows) for (const k of r.byCol.keys()) usedCols.add(k);
  const activeCols = laneCols.filter(
    (c) => usedCols.has(c.id) || (c.id !== UNSCHEDULED && cycles.length > 0),
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

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2 text-sm">
        <div className="flex items-center gap-2 font-medium text-[var(--text)]">
          <MapIcon className="size-4 text-[var(--primary)]" /> Roadmap
        </div>
        <span className="text-[var(--text-muted)]">
          {rows.length} epics · {cycles.length} increments
        </span>
        {currentUserId && (
          <Button
            size="sm"
            variant={assignedToMe ? "default" : "outline"}
            aria-pressed={assignedToMe}
            className="h-7 gap-1.5"
            onClick={() => setAssignedToMe((v) => !v)}
          >
            <UserCheck className="h-3.5 w-3.5" />
            Assigned to me
          </Button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Hide done
          </label>
          <button
            onClick={() =>
              setCollapsed(allCollapsed ? new Set() : new Set(rows.map((r) => r.epic.id)))
            }
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      </div>

      {/* grid */}
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={MapIcon}
            title={mineOnly ? "Nothing assigned to you" : "No epics to roadmap yet"}
            description={
              mineOnly
                ? "No epics or features here are assigned to you. Toggle off “Assigned to me” to see the full roadmap."
                : "Create Epic-type work items (with Features under them) and assign them to increments — they'll appear here as strategic swimlanes across your PIs."
            }
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
                            <div className="rounded bg-[var(--muted)]/40 px-2 py-1 text-[11px] text-[var(--text-muted)]">
                              {feats.length} feature{feats.length === 1 ? "" : "s"}
                            </div>
                          )
                        : feats.map((f) => (
                            <FeatureCard key={f.id} item={f} onClick={() => setDetailId(f.id)} />
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
        item={detailItem}
        open={detailItem !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        orgId={orgId}
        projectId={projectId}
        members={members}
        cycles={cycles}
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

function FeatureCard({ item, onClick }: { item: WorkItem; onClick: () => void }) {
  const done = !!item.completedAt;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-left text-xs transition-colors hover:border-[var(--primary)]",
        done && "opacity-70",
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
        <span className={cn("line-clamp-2 text-[var(--text)]", done && "line-through")}>
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
      <div className="border-b border-[var(--border)] px-4 py-2">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="flex-1 space-y-2 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
