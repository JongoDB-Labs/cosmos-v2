"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  DndContext,
  closestCorners,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { KanbanColumn } from "./kanban-column";
import { KanbanCard } from "./kanban-card";
import {
  FilterBar,
  parseFilters,
  serializeFilters,
  bareTypeKey,
  type BoardFilters,
} from "@/components/boards/shared/filter-bar";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkItemRealtime } from "@/hooks/use-work-item-realtime";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import type {
  Board,
  BoardColumn,
  WorkItem,
  OrgMember,
  Cycle,
} from "@/types/models";

interface KanbanBoardProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  /**
   * Default cycle/sprint to scope the board to when the URL carries no explicit
   * cycle filter. The Sprint board passes the active sprint here so a SCRUM board
   * opens already focused on the current sprint (the user can still clear it via
   * the filter bar).
   */
  initialCycleId?: string;
}

// Separator for composite swimlane droppable ids: `${laneId}::${columnKey}`.
// In flat mode the droppable id is just the column key (no separator), so
// `resolveColumnKey` is a no-op there.
const LANE_SEP = "::";

/**
 * Strip a swimlane prefix off a droppable id to recover the column key. A card
 * (`over` is another item) has an `item.id` (UUID, no separator) so it's
 * returned untouched and the caller resolves the column from the item instead.
 */
function resolveColumnKey(id: string): string {
  const idx = id.indexOf(LANE_SEP);
  return idx === -1 ? id : id.slice(idx + LANE_SEP.length);
}

function titleCase(s: string): string {
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

/**
 * Exported board. `KanbanBoardInner` reads `useSearchParams()` (to make the
 * active filters shareable/reload-stable), which under Cache Components must be
 * client-rendered beneath a <Suspense> boundary — so we wrap it here rather
 * than relying on the (single, fully-client) parent renderer to provide one.
 */
export function KanbanBoard(props: KanbanBoardProps) {
  return (
    <Suspense fallback={<KanbanBoardSkeleton />}>
      <KanbanBoardInner {...props} />
    </Suspense>
  );
}

function KanbanBoardInner({
  orgId,
  projectId,
  projectKey,
  boardId,
  initialCycleId,
}: KanbanBoardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Initialize filter state FROM the URL so a shared/reloaded link restores the
  // filtered + swim-laned view. Computed once on mount (searchParams is stable
  // for the initializer); subsequent URL writes flow the other direction.
  const [filters, setFilters] = useState<BoardFilters>(() => {
    const parsed = parseFilters(searchParams);
    // Seed the sprint scope from the caller (Sprint board) only when the URL
    // doesn't already pin a cycle — so a shared/filtered link still wins.
    if (initialCycleId && !parsed.cycleId) {
      return { ...parsed, cycleId: initialCycleId };
    }
    return parsed;
  });
  // Snapshot of items at drag START (before handleDragOver mutates them for the
  // live preview), so a rejected move can be truly reverted.
  const beforeDragItemsRef = useRef<WorkItem[]>([]);
  const [activeItem, setActiveItem] = useState<WorkItem | null>(null);
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  // Monotonic request id: a realtime refetch may race the initial load (or
  // another refetch), so only the newest response is allowed to write state.
  const reqSeq = useRef(0);

  // Fetch board, items, members, sprints. `silent` skips the loading skeleton
  // so a live-update refetch doesn't flash the board away under the user.
  const fetchData = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++reqSeq.current;
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const [boardRes, itemsRes, membersRes, sprintsRes] = await Promise.all([
          fetch(`${basePath}/boards/${boardId}`),
          fetch(`${basePath}/work-items`),
          fetch(`/api/v1/orgs/${orgId}/members`),
          fetch(`${basePath}/cycles`),
        ]);

        if (!boardRes.ok) throw new Error("Failed to load board");
        if (!itemsRes.ok) throw new Error("Failed to load work items");

        const boardData: Board = await boardRes.json();
        const itemsData: WorkItem[] = await itemsRes.json();
        const membersData: OrgMember[] | null = membersRes.ok
          ? await membersRes.json()
          : null;
        const cyclesData: Cycle[] | null = sprintsRes.ok
          ? await sprintsRes.json()
          : null;

        if (seq !== reqSeq.current) return; // superseded by a newer fetch

        setBoard(boardData);
        setColumns(
          (boardData.columns ?? []).sort((a, b) => a.sortOrder - b.sortOrder)
        );
        setItems(itemsData);
        if (membersData) setMembers(membersData);
        if (cyclesData) setCycles(cyclesData);
      } catch (err) {
        if (seq === reqSeq.current) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (seq === reqSeq.current && !opts?.silent) setLoading(false);
      }
    },
    [orgId, basePath, boardId],
  );

  // Initial load. fetchData sets `loading` up front (the skeleton); that's the
  // intended one-shot mount fetch, not a render-loop — same allowance the
  // detail sheet uses for its derive-from-prop effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // Live updates: silently refetch when another client mutates this project's
  // work items. Debounced so a burst of events coalesces into one refetch.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWorkItemRealtime(orgId, projectId, () => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      void fetchData({ silent: true });
    }, 400);
  });

  // Filters -> URL. Serialize the active filters into the query string so the
  // board is shareable + reload-stable. The search term is debounced (200ms)
  // so typing doesn't spam history; other toggles write on the next tick.
  // `router.replace` (not push) keeps the back button sane. The board is a
  // client component, so this client-side searchParams write is fine and adds
  // no server-side dynamic read.
  useEffect(() => {
    const handle = setTimeout(() => {
      const qs = serializeFilters(filters);
      const next = qs ? `${pathname}?${qs}` : pathname;
      const current = serializeFilters(parseFilters(searchParams));
      // Avoid a redundant replace (e.g. on mount when URL already matches).
      if (current === qs) return;
      router.replace(next, { scroll: false });
    }, 200);
    return () => clearTimeout(handle);
  }, [filters, pathname, router, searchParams]);

  // Apply filters
  const filteredItems = items.filter((item) => {
    if (
      filters.search &&
      !item.title.toLowerCase().includes(filters.search.toLowerCase()) &&
      !String(item.ticketNumber).includes(filters.search)
    ) {
      return false;
    }
    if (
      filters.types.length > 0 &&
      !filters.types.includes(bareTypeKey(item.workItemType?.key))
    ) {
      return false;
    }
    if (
      filters.priorities.length > 0 &&
      !filters.priorities.includes(item.priority)
    ) {
      return false;
    }
    if (filters.assigneeId && item.assigneeId !== filters.assigneeId) {
      return false;
    }
    if (filters.cycleId && item.cycleId !== filters.cycleId) {
      return false;
    }
    return true;
  });

  function itemsForColumn(columnKey: string) {
    return filteredItems
      .filter((i) => i.columnKey === columnKey)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // Swimlanes are a PURE PRESENTATION wrapper: we group the already-filtered
  // items by the chosen axis and render one labelled lane per group. Drag IDs
  // (card id over column.key) are unchanged, so a card still moves between
  // columns — and across lanes — exactly as before. Each lane just feeds its
  // own subset of items into the same KanbanColumn set. (Plain computations,
  // memoized automatically by the React Compiler — matching itemsForColumn /
  // filteredItems above.)
  const memberName = (userId: string | null) => {
    if (!userId) return null;
    const m = members.find((mem) => mem.userId === userId);
    return m?.user?.displayName ?? userId;
  };

  // (laneId, laneLabel) for an item under the active axis. laneId === "" is the
  // empty / "none" bucket (Unassigned, No cycle, …).
  const swimlaneKeyOf = (item: WorkItem): { id: string; label: string } => {
    switch (filters.swimlaneBy) {
      case "assignee":
        return {
          id: item.assigneeId ?? "",
          label: memberName(item.assigneeId) ?? "Unassigned",
        };
      case "priority":
        return { id: item.priority, label: titleCase(item.priority) };
      case "type": {
        const t = item.workItemType;
        return { id: t?.key ?? "", label: t?.name ?? "No type" };
      }
      case "cycle": {
        const c = cycles.find((cy) => cy.id === item.cycleId);
        return {
          id: item.cycleId ?? "",
          label: c?.name ?? (item.cycleId ? item.cycleId : "No cycle"),
        };
      }
      case "parent":
        return {
          id: item.parentId ?? "",
          label: item.parentId
            ? items.find((p) => p.id === item.parentId)?.title ??
              `Parent ${item.parentId}`
            : "No parent",
        };
      default:
        return { id: "", label: "—" };
    }
  };

  function computeLanes() {
    if (filters.swimlaneBy === "none") return null;
    const map = new Map<
      string,
      { id: string; label: string; items: WorkItem[] }
    >();
    for (const item of filteredItems) {
      const { id, label } = swimlaneKeyOf(item);
      const existing = map.get(id);
      if (existing) existing.items.push(item);
      else map.set(id, { id, label, items: [item] });
    }
    // Stable, friendly order: empty bucket last, otherwise alphabetical.
    return Array.from(map.values()).sort((a, b) => {
      if (a.id === "" && b.id !== "") return 1;
      if (b.id === "" && a.id !== "") return -1;
      return a.label.localeCompare(b.label);
    });
  }

  const lanes = computeLanes();

  function itemsForColumnInLane(columnKey: string, laneItems: WorkItem[]) {
    return laneItems
      .filter((i) => i.columnKey === columnKey)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // DnD sensors - hybrid touch-aware activation:
  //   mouse: PointerSensor with 5px drag distance (immediate)
  //   touch: TouchSensor with 250ms long-press + 5px tolerance (avoids
  //   fighting native scroll on phones).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    const item = items.find((i) => i.id === event.active.id);
    setActiveItem(item ?? null);
    beforeDragItemsRef.current = items;
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeItemId = active.id as string;
    const overId = over.id as string;

    // Find the source item
    const srcItem = items.find((i) => i.id === activeItemId);
    if (!srcItem) return;

    // Determine target column key. In swimlane mode `over.id` for a column is a
    // composite `${laneId}::${columnKey}`; resolveColumnKey() strips the lane
    // prefix so the drag still keys off the column (status) only.
    let targetColumnKey: string | null = null;

    // Check if over is a column
    const overColumn = columns.find((c) => c.key === resolveColumnKey(overId));
    if (overColumn) {
      targetColumnKey = overColumn.key;
    } else {
      // Over is another item - find its column
      const overItem = items.find((i) => i.id === overId);
      if (overItem) {
        targetColumnKey = overItem.columnKey;
      }
    }

    if (!targetColumnKey || srcItem.columnKey === targetColumnKey) return;

    // Move item to the new column optimistically
    setItems((prev) =>
      prev.map((i) =>
        i.id === activeItemId ? { ...i, columnKey: targetColumnKey } : i
      )
    );
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItem(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const movedItem = items.find((i) => i.id === activeId);
      if (!movedItem) return;

      // Determine target column. Resolve any swimlane prefix off the droppable
      // id back to the bare column key (no-op in flat mode).
      let targetColumnKey = movedItem.columnKey;
      const overColumn = columns.find((c) => c.key === resolveColumnKey(overId));
      if (overColumn) {
        targetColumnKey = overColumn.key;
      } else {
        const overItem = items.find((i) => i.id === overId);
        if (overItem) {
          targetColumnKey = overItem.columnKey;
        }
      }

      // Get items in the target column
      const colItems = items
        .filter((i) => i.columnKey === targetColumnKey && i.id !== activeId)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      // If dropped on another item, insert at its position
      let newOrder = colItems.length;
      if (!overColumn) {
        const overIdx = colItems.findIndex((i) => i.id === overId);
        if (overIdx >= 0) newOrder = overIdx;
      }

      // WIP-limit enforcement. Use the PRE-DRAG snapshot to find the card's
      // origin column (handleDragOver may have already moved it optimistically),
      // so we only enforce when the card is genuinely ENTERING a new column.
      // colItems already excludes the moved card, so the post-move count is
      // colItems.length + 1.
      const originColumnKey =
        beforeDragItemsRef.current.find((i) => i.id === activeId)?.columnKey ??
        movedItem.columnKey;
      const isEnteringNewColumn = originColumnKey !== targetColumnKey;
      const targetColumn = columns.find((c) => c.key === targetColumnKey);
      const wipLimit = targetColumn?.wipLimit ?? null;
      const wouldExceedWip =
        isEnteringNewColumn &&
        wipLimit != null &&
        colItems.length + 1 > wipLimit;

      if (wouldExceedWip) {
        const label = targetColumn?.name ?? targetColumnKey;
        // Hard-enforce mode (opt-in via board.config.wipHardEnforce) rolls the
        // move back using the pre-drag snapshot; default is warn-but-allow.
        const hardEnforce = board?.config?.wipHardEnforce === true;
        if (hardEnforce) {
          setItems(beforeDragItemsRef.current);
          notifyError(
            new Error("wip-limit"),
            `"${label}" is at its WIP limit (${wipLimit}) — move blocked.`,
          );
          return;
        }
        toast.warning(`"${label}" is at its limit (${wipLimit})`);
      }

      // Optimistic update. (Pre-drag state was captured in handleDragStart,
      // before handleDragOver moved the card, so we can truly revert.)
      setItems((prev) =>
        prev.map((i) =>
          i.id === activeId
            ? { ...i, columnKey: targetColumnKey, sortOrder: newOrder }
            : i
        )
      );

      // Fire confetti when the item is dragged into a DONE column for the
      // first time and its WorkItemType has celebrateOnComplete enabled.
      const isDoneColumn = (key: string) =>
        ["done", "completed", "closed"].some((k) =>
          key.toLowerCase().includes(k)
        );
      if (
        targetColumnKey !== movedItem.columnKey &&
        isDoneColumn(targetColumnKey) &&
        !isDoneColumn(movedItem.columnKey) &&
        movedItem.workItemType?.celebrateOnComplete
      ) {
        void import("@/lib/confetti").then(({ celebrate }) => celebrate());
      }

      // API call to persist; revert the optimistic move + notify on failure
      // (a raw fetch does NOT reject on 4xx/5xx, so check res.ok explicitly).
      void (async () => {
        try {
          const res = await fetch(`${basePath}/work-items/${activeId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              columnKey: targetColumnKey,
              sortOrder: newOrder,
            }),
          });
          if (!res.ok) throw new Error(`Failed to move card (HTTP ${res.status})`);
        } catch (err) {
          console.error("Failed to update work item position:", err);
          setItems(beforeDragItemsRef.current);
          notifyError(err, "Couldn't move the card — it's been put back.");
        }
      })();
    },
    [items, columns, basePath, board]
  );

  function handleCardCreated(item: WorkItem) {
    setItems((prev) => [...prev, item]);
  }

  function handleCardClick(item: WorkItem) {
    setDetailItem(item);
    setDetailOpen(true);
  }

  function handleItemUpdate(updated: WorkItem) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setDetailItem(updated);
  }

  function handleItemDeleted(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function handleItemDuplicated(dupe: WorkItem) {
    // Append the new item so it shows immediately, then open it for editing
    // (it lands in the same column as its source).
    setItems((prev) => [...prev, dupe]);
    setDetailItem(dupe);
  }

  if (loading) {
    return <KanbanBoardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">
            Failed to load board
          </p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={members}
        cycles={cycles}
        showSwimlane
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {columns.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
            This board has no columns configured.
          </div>
        ) : lanes ? (
          // Swimlane mode: one labelled horizontal lane per group, each
          // containing the full column set. Lanes are presentation only — the
          // single DndContext above spans all of them so cards drag within and
          // across lanes (a drop changes columnKey/status; the lane it lands in
          // follows from the unchanged grouping attribute).
          <div className="flex flex-col gap-4 overflow-auto flex-1 p-4">
            {lanes.map((lane) => (
              <section key={lane.id || "__none__"} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 sticky left-0">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {lane.label}
                  </h2>
                  <span className="inline-flex items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground min-w-[20px] h-5">
                    {lane.items.length}
                  </span>
                </div>
                <div className="flex gap-3 overflow-x-auto scrollbar-x">
                  {columns.map((col) => (
                    <KanbanColumn
                      key={`${lane.id}${LANE_SEP}${col.id}`}
                      column={col}
                      droppableId={`${lane.id}${LANE_SEP}${col.key}`}
                      items={itemsForColumnInLane(col.key, lane.items)}
                      orgId={orgId}
                      projectId={projectId}
                      projectKey={projectKey}
                      members={members}
                      onCardClick={handleCardClick}
                      onCardCreated={handleCardCreated}
                      hideQuickCreate
                    />
                  ))}
                </div>
              </section>
            ))}
            {lanes.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                No items match the current filters.
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto scrollbar-x flex-1 p-4">
            {columns.map((col) => (
              <KanbanColumn
                key={col.id}
                column={col}
                items={itemsForColumn(col.key)}
                orgId={orgId}
                projectId={projectId}
                projectKey={projectKey}
                members={members}
                onCardClick={handleCardClick}
                onCardCreated={handleCardCreated}
              />
            ))}
          </div>
        )}

        <DragOverlay>
          {activeItem && (
            <div className="w-72">
              <KanbanCard
                item={activeItem}
                onClick={() => {}}
                members={members}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <CardDetailSheet
        item={detailItem}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        orgId={orgId}
        projectId={projectId}
        members={members}
        cycles={cycles}
        columns={columns}
        onUpdate={handleItemUpdate}
        onDelete={handleItemDeleted}
        onDuplicate={handleItemDuplicated}
      />
    </div>
  );
}

function KanbanBoardSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="flex gap-3 overflow-x-auto flex-1 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            {i < 2 && <Skeleton className="h-24 w-full rounded-lg" />}
          </div>
        ))}
      </div>
    </div>
  );
}
