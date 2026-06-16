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
  matchesCustomFieldFilters,
  type BoardFilters,
} from "@/components/boards/shared/filter-bar";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckSquare, X } from "lucide-react";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
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

  // Bulk-select mode: toggling it disables drag (the DndContext gets no sensors)
  // and turns cards into checkbox toggles, so selection never fights dnd-kit.
  const { can } = usePermissions();
  const canBulkEdit = can(Permission.ITEM_BULK_EDIT);
  const canBulkDelete = can(Permission.ITEM_DELETE);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  // Custom-field defs for this project — drives the FilterBar's per-field
  // controls and the client-side custom-field predicate below.
  const { fields: projectCustomFields } = useCustomFields(orgId, projectId);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  // Ctrl/Cmd-click a card (outside select mode) → enter select mode with it
  // selected (FR: "hold ctrl/cmd to select multiple cards").
  const ctrlSelect = useCallback((id: string) => {
    setSelectMode(true);
    setSelectedIds((prev) => new Set(prev).add(id));
  }, []);

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
    if (
      !matchesCustomFieldFilters(
        item.customFields,
        filters.customFields,
        projectCustomFields,
      )
    ) {
      return false;
    }
    return true;
  });

  // Selection narrowed to what's actually on screen under the current filters.
  // Drives the "N selected" counter, the Delete confirm label, and the bulk
  // payloads (passed in as the `ids` argument) — so the count never lies and a
  // narrowed filter can never apply a bulk move/assign/delete to items the user
  // can no longer see. The full selection set persists across filtering; only
  // the visible subset is ever acted on.
  const filteredIdSet = new Set(filteredItems.map((i) => i.id));
  const visibleSelectedIds = [...selectedIds].filter((id) =>
    filteredIdSet.has(id),
  );

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

      // Build the target column's new order (moved card inserted at newOrder)
      // and re-sequence EVERY card in it to a unique 0..n sortOrder. The server
      // stores sortOrder verbatim (no sibling shift), so assigning the moved
      // card the index of the card it landed on would otherwise collide two
      // cards at the same order — making the drop position non-deterministic
      // after a refetch. Only the target column needs renumbering; the source
      // column keeps its relative order (a gap is harmless). Mirrors the
      // Backlog view's reorder model.
      const reordered = [...colItems];
      reordered.splice(newOrder, 0, { ...movedItem, columnKey: targetColumnKey });
      const seqById = new Map(reordered.map((it, idx) => [it.id, idx] as const));

      // Optimistic update. (Pre-drag state was captured in handleDragStart,
      // before handleDragOver moved the card, so we can truly revert.)
      setItems((prev) =>
        prev.map((i) => {
          const seq = seqById.get(i.id);
          if (i.id === activeId) {
            return { ...i, columnKey: targetColumnKey, sortOrder: seq ?? newOrder };
          }
          return seq !== undefined ? { ...i, sortOrder: seq } : i;
        })
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

      // Persist the moved card (column + new order) plus any sibling whose
      // order actually shifted, in parallel. Revert the WHOLE drag on any
      // failure (raw fetch does NOT reject on 4xx/5xx — check res.ok).
      const updates: { id: string; body: Record<string, unknown> }[] = [
        {
          id: activeId,
          body: { columnKey: targetColumnKey, sortOrder: seqById.get(activeId) ?? newOrder },
        },
      ];
      for (const it of colItems) {
        const seq = seqById.get(it.id);
        if (seq !== undefined && seq !== it.sortOrder) {
          updates.push({ id: it.id, body: { sortOrder: seq } });
        }
      }
      void (async () => {
        try {
          const results = await Promise.all(
            updates.map((u) =>
              fetch(`${basePath}/work-items/${u.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(u.body),
              }),
            ),
          );
          if (results.some((r) => !r.ok)) {
            throw new Error("Failed to persist the new order");
          }
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

  // Open another item (a sub-item or a linked item) in the same detail sheet.
  // Same-project items are already loaded, so look up locally; fall back to a
  // fetch for anything not on this board (e.g. a parent-scoped child).
  async function handleOpenItemById(id: string) {
    const found = items.find((i) => i.id === id);
    if (found) {
      setDetailItem(found);
      setDetailOpen(true);
      return;
    }
    try {
      const res = await fetch(`${basePath}/work-items/${id}`);
      if (!res.ok) return;
      const full: WorkItem = await res.json();
      setDetailItem(full);
      setDetailOpen(true);
    } catch {
      /* swallow — the link row stays put */
    }
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

  // Bulk-apply a field change to all selected cards via the shared bulk API,
  // then silently refetch and clear the selection (staying in select mode).
  const bulkUpdate = useCallback(
    async (ids: string[], update: Record<string, unknown>, label: string) => {
      // `ids` is the caller's visible-selected subset — never the raw selection.
      if (ids.length === 0) return;
      setBulkPending(true);
      try {
        const res = await fetch(`${basePath}/work-items/bulk`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, update }),
        });
        if (!res.ok) throw new Error("bulk update failed");
        toast.success(`Updated ${ids.length} item${ids.length === 1 ? "" : "s"} — ${label}`);
        setSelectedIds(new Set());
        await fetchData({ silent: true });
      } catch (err) {
        notifyError(err, "Couldn't apply the bulk change.");
      } finally {
        setBulkPending(false);
      }
    },
    [basePath, fetchData],
  );

  const bulkDelete = useCallback(async (ids: string[]) => {
    // `ids` is the caller's visible-selected subset — never the raw selection.
    if (ids.length === 0) return;
    setBulkPending(true);
    try {
      const res = await fetch(`${basePath}/work-items/bulk`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("bulk delete failed");
      toast.success(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`);
      setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
      setSelectedIds(new Set());
    } catch (err) {
      notifyError(err, "Couldn't delete the selected items.");
    } finally {
      setBulkPending(false);
    }
  }, [basePath]);

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
        customFields={projectCustomFields}
        showSwimlane
      />

      {/* Bulk-select toolbar. "Select" enters a mode where drag is OFF and cards
          toggle; the action bar appears once something's selected. */}
      {(canBulkEdit || canBulkDelete) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5">
          {!selectMode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectMode(true)}
              className="text-muted-foreground"
            >
              <CheckSquare className="h-4 w-4" />
              Select
            </Button>
          ) : (
            <>
              <span className="text-sm font-medium">
                {visibleSelectedIds.length} selected
                {selectedIds.size > visibleSelectedIds.length && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({selectedIds.size - visibleSelectedIds.length} hidden by
                    filters)
                  </span>
                )}
              </span>
              {visibleSelectedIds.length > 0 && (
                <>
                  {canBulkEdit && (
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (!v) return;
                        const col = columns.find((c) => c.key === v);
                        void bulkUpdate(visibleSelectedIds, { columnKey: v }, `moved to ${col?.name ?? v}`);
                      }}
                    >
                      <SelectTrigger size="sm" className="h-7">
                        <SelectValue placeholder="Move to…" />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((c) => (
                          <SelectItem key={c.key} value={c.key}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canBulkEdit && (
                    <Select
                      value=""
                      onValueChange={(v) =>
                        v && bulkUpdate(visibleSelectedIds, { priority: v }, `priority ${titleCase(v)}`)
                      }
                    >
                      <SelectTrigger size="sm" className="h-7">
                        <SelectValue placeholder="Priority…" />
                      </SelectTrigger>
                      <SelectContent>
                        {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
                          <SelectItem key={p} value={p}>
                            {titleCase(p)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canBulkEdit && members.length > 0 && (
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (!v) return;
                        const m = members.find((mm) => mm.userId === v);
                        void bulkUpdate(
                          visibleSelectedIds,
                          { assigneeId: v },
                          `assigned to ${m?.user?.displayName ?? "member"}`,
                        );
                      }}
                    >
                      <SelectTrigger size="sm" className="h-7">
                        <SelectValue placeholder="Assign…" />
                      </SelectTrigger>
                      <SelectContent>
                        {members.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.user?.displayName ?? "Member"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canBulkEdit && cycles.length > 0 && (
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (!v) return;
                        const target = v === "__none__" ? null : v;
                        const c = cycles.find((cy) => cy.id === v);
                        void bulkUpdate(
                          visibleSelectedIds,
                          { cycleId: target },
                          target ? `moved to ${c?.name ?? "cycle"}` : "removed from cycle",
                        );
                      }}
                    >
                      <SelectTrigger size="sm" className="h-7">
                        <SelectValue placeholder="Cycle…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No cycle</SelectItem>
                        {cycles.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canBulkDelete && (
                    <ConfirmButton
                      size="sm"
                      pending={bulkPending}
                      confirmLabel={`Delete ${visibleSelectedIds.length}`}
                      onConfirm={() => void bulkDelete(visibleSelectedIds)}
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={exitSelectMode}
                className="ml-auto text-muted-foreground"
              >
                <X className="h-4 w-4" />
                Done
              </Button>
            </>
          )}
        </div>
      )}

      <DndContext
        // No sensors while selecting → drag is fully disabled, so toggling a
        // card can never start a drag.
        sensors={selectMode ? [] : sensors}
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
                      selectMode={selectMode}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                      onCtrlSelect={ctrlSelect}
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
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                      onCtrlSelect={ctrlSelect}
              />
            ))}
          </div>
        )}

        <DragOverlay>
          {activeItem && (
            <div className="w-[84vw] max-w-[19rem] sm:w-72">
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
        projectItems={items}
        onItemCreated={handleCardCreated}
        onOpenItem={handleOpenItemById}
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
          <div key={i} className="w-[84vw] max-w-[19rem] shrink-0 space-y-3 sm:w-72">
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
