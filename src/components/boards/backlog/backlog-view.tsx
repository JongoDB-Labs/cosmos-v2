"use client";

import { useMemo, useState, useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListChecks,
  MoveRight,
  Inbox,
} from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { useWorkItemRealtime } from "@/hooks/use-work-item-realtime";
import type {
  Board,
  BoardColumn,
  WorkItem,
  OrgMember,
  Cycle,
} from "@/types/models";

interface BacklogViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

// Map the WorkItem priority enum onto the Badge's fixed variant vocabulary so
// the chip uses the same theme tokens as the rest of the app.
const PRIORITY_VARIANT: Record<WorkItem["priority"], BadgeVariant> = {
  CRITICAL: "critical",
  HIGH: "blocked",
  MEDIUM: "progress",
  LOW: "neutral",
};

const PRIORITY_LABEL: Record<WorkItem["priority"], string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

/** Prettify a raw column key (e.g. "in_progress" -> "In Progress"). */
function prettifyKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Short, human date range for a cycle/sprint header. */
function formatCycleRange(cycle: Cycle): string {
  const fmt = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const start = formatStart(cycle.startDate, fmt);
  const end = formatStart(cycle.endDate, fmt);
  if (start && end) return `${start} – ${end}`;
  return start || end || "";
}

function formatStart(value: string | null | undefined, fmt: (s: string) => string): string {
  return value ? fmt(value) : "";
}

export function BacklogView({
  orgId,
  projectId,
  projectKey,
  boardId,
}: BacklogViewProps) {
  const qc = useQueryClient();
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const [hideDone, setHideDone] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const boardKey = useOrgQueryKey("board", boardId);
  const itemsKey = useOrgQueryKey("work-items", projectId);
  // Live updates: invalidate the backlog's items query when another client
  // mutates this project's work items (FR: issue updates without refresh).
  useWorkItemRealtime(orgId, projectId, () => {
    void qc.invalidateQueries({ queryKey: itemsKey });
  });
  const membersKey = useOrgQueryKey("members");
  const cyclesKey = useOrgQueryKey("cycles", projectId);

  const [boardQ, itemsQ, membersQ, cyclesQ] = useQueries({
    queries: [
      {
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
      },
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
      {
        queryKey: cyclesKey,
        queryFn: () => jsonFetch<Cycle[]>(`${basePath}/cycles`),
      },
    ],
  });

  const board: Board | null = boardQ.data ?? null;
  const columns: BoardColumn[] = useMemo(
    () => (board?.columns ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [board],
  );
  const items: WorkItem[] = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const members: OrgMember[] = useMemo(() => membersQ.data ?? [], [membersQ.data]);
  const cycles: Cycle[] = useMemo(() => cyclesQ.data ?? [], [cyclesQ.data]);

  const loading =
    boardQ.isLoading || itemsQ.isLoading || membersQ.isLoading || cyclesQ.isLoading;
  const fatalError = boardQ.error || itemsQ.error;
  const error = fatalError
    ? fatalError instanceof Error
      ? fatalError.message
      : "Unknown error"
    : null;

  const memberById = useMemo(() => {
    const map = new Map<string, OrgMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const columnMap = useMemo(() => {
    const map = new Map<string, BoardColumn>();
    for (const c of columns) map.set(c.key, c);
    return map;
  }, [columns]);

  // "Done" = the canonical `done` column key (per spec); also treat any column
  // the board flags as DONE category as done, so re-themed boards behave.
  const isDone = useCallback(
    (item: WorkItem) =>
      item.columnKey === "done" || columnMap.get(item.columnKey)?.category === "DONE",
    [columnMap],
  );

  const cycleMap = useMemo(() => {
    const map = new Map<string, Cycle>();
    for (const c of cycles) map.set(c.id, c);
    return map;
  }, [cycles]);

  // Persist a sortOrder change for a single item. The work-item route accepts a
  // partial PUT (every field optional), which is the cosmos convention for
  // re-ranking (kanban/table use the same endpoint + method).
  const reorderMutation = useOrgMutation<
    unknown,
    Error,
    { id: string; sortOrder: number }[]
  >({
    mutationFn: async (updates) => {
      await Promise.all(
        updates.map((u) =>
          jsonFetch(`${basePath}/work-items/${u.id}`, {
            method: "PUT",
            body: JSON.stringify({ sortOrder: u.sortOrder }),
          }),
        ),
      );
    },
    invalidate: [["work-items", projectId]],
    onError: (err) => notifyError(err, "Couldn't save the new order."),
  });

  // Reassign an item to a cycle (or back to the backlog when cycleId is null).
  const assignMutation = useOrgMutation<
    unknown,
    Error,
    { id: string; cycleId: string | null }
  >({
    mutationFn: ({ id, cycleId }) =>
      jsonFetch(`${basePath}/work-items/${id}`, {
        method: "PUT",
        body: JSON.stringify({ cycleId }),
      }),
    invalidate: [["work-items", projectId]],
    onMutate: ({ id, cycleId }) => {
      const previous = qc.getQueryData<WorkItem[]>(itemsKey);
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).map((i) => (i.id === id ? { ...i, cycleId } : i)),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      const ctx = context as { previous?: WorkItem[] } | undefined;
      if (ctx?.previous) qc.setQueryData(itemsKey, ctx.previous);
      notifyError(err, "Couldn't move the item to that sprint.");
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Sort helper: primary key sortOrder, tiebreak ticketNumber.
  const byRank = useCallback(
    (a: WorkItem, b: WorkItem) =>
      a.sortOrder - b.sortOrder || a.ticketNumber - b.ticketNumber,
    [],
  );

  const visibleItems = useMemo(
    () => (hideDone ? items.filter((i) => !isDone(i)) : items),
    [items, hideDone, isDone],
  );

  // Top "Backlog" section = items with no cycle, ranked.
  const backlogItems = useMemo(
    () => visibleItems.filter((i) => i.cycleId == null).slice().sort(byRank),
    [visibleItems, byRank],
  );

  // One section per cycle, in (status, startDate) order, with its ranked items.
  const cycleSections = useMemo(() => {
    const grouped = new Map<string, WorkItem[]>();
    for (const item of visibleItems) {
      if (item.cycleId == null) continue;
      const arr = grouped.get(item.cycleId);
      if (arr) arr.push(item);
      else grouped.set(item.cycleId, [item]);
    }
    // Order: known cycles first (by startDate), then any orphan cycleId buckets.
    const statusRank: Record<Cycle["status"], number> = {
      ACTIVE: 0,
      PLANNED: 1,
      COMPLETED: 2,
    };
    return Array.from(grouped.entries())
      .map(([cycleId, secItems]) => ({
        cycle: cycleMap.get(cycleId) ?? null,
        cycleId,
        items: secItems.slice().sort(byRank),
      }))
      .sort((a, b) => {
        if (a.cycle && b.cycle) {
          const sr = statusRank[a.cycle.status] - statusRank[b.cycle.status];
          if (sr !== 0) return sr;
          return (a.cycle.startDate ?? "").localeCompare(b.cycle.startDate ?? "");
        }
        if (a.cycle) return -1;
        if (b.cycle) return 1;
        return a.cycleId.localeCompare(b.cycleId);
      });
  }, [visibleItems, cycleMap, byRank]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ordered = backlogItems;
      const oldIndex = ordered.findIndex((i) => i.id === active.id);
      const newIndex = ordered.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Compute the post-move array and renumber sequentially.
      const next = ordered.slice();
      const [moved] = next.splice(oldIndex, 1);
      next.splice(newIndex, 0, moved);

      const movedIds = new Set(next.map((i) => i.id));
      const updates = next.map((i, idx) => ({ id: i.id, sortOrder: idx }));

      // Optimistically write the new sortOrders into the cache so the list
      // settles instantly; the mutation persists + invalidates.
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        (prev ?? []).map((i) =>
          movedIds.has(i.id)
            ? { ...i, sortOrder: next.findIndex((n) => n.id === i.id) }
            : i,
        ),
      );

      reorderMutation.mutate(updates);
    },
    [backlogItems, qc, itemsKey, reorderMutation],
  );

  const openDetail = useCallback((item: WorkItem) => {
    setDetailItem(item);
    setDetailOpen(true);
  }, []);

  const handleItemUpdate = useCallback((updated: WorkItem) => {
    qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
      (prev ?? []).map((i) => (i.id === updated.id ? updated : i)),
    );
    setDetailItem(updated);
  }, [qc, itemsKey]);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Build the "Move to sprint" menu for a row. Excludes the item's current
  // cycle and offers "Backlog" only when the item is in a cycle.
  const buildMenuGroups = useCallback(
    (item: WorkItem): ActionMenuGroup[] => {
      const targets = cycles
        .filter((c) => c.id !== item.cycleId)
        .map((c) => ({
          label: c.name,
          icon: MoveRight,
          onClick: () => assignMutation.mutate({ id: item.id, cycleId: c.id }),
        }));
      const items = [
        ...(item.cycleId != null
          ? [
              {
                label: "Backlog",
                icon: Inbox,
                onClick: () =>
                  assignMutation.mutate({ id: item.id, cycleId: null }),
              },
            ]
          : []),
        ...targets,
      ];
      return [{ label: "Move to sprint", items }];
    },
    [cycles, assignMutation],
  );

  if (loading) return <BacklogSkeleton />;

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <p className="mb-2 text-sm text-destructive">Failed to load backlog</p>
          <p className="text-xs text-[var(--text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  const totalVisible = backlogItems.length + cycleSections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/50 px-4 py-2">
        <span className="text-xs text-[var(--text-muted)]">
          {totalVisible} item{totalVisible === 1 ? "" : "s"}
        </span>
        <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          />
          Hide done
        </label>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ListChecks}
            title="No work items yet"
            description="Create work items to start building your product backlog."
          />
        </div>
      ) : totalVisible === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ListChecks}
            title="Everything is done"
            description="Turn off “Hide done” to see completed items."
          />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Backlog section — drag to re-rank */}
          <BacklogSection
            sectionKey="__backlog__"
            title="Backlog"
            subtitle={null}
            count={backlogItems.length}
            collapsed={!!collapsed["__backlog__"]}
            onToggle={() => toggleCollapsed("__backlog__")}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={backlogItems.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                {backlogItems.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-[var(--text-muted)]">
                    No backlog items.
                  </p>
                ) : (
                  backlogItems.map((item) => (
                    <SortableRow
                      key={item.id}
                      item={item}
                      projectKey={projectKey}
                      member={item.assigneeId ? memberById.get(item.assigneeId) : undefined}
                      statusLabel={
                        columnMap.get(item.columnKey)?.name ??
                        prettifyKey(item.columnKey)
                      }
                      cycleName={item.cycleId ? cycleMap.get(item.cycleId)?.name ?? null : null}
                      done={isDone(item)}
                      menuGroups={buildMenuGroups(item)}
                      onOpen={() => openDetail(item)}
                    />
                  ))
                )}
              </SortableContext>
            </DndContext>
          </BacklogSection>

          {/* One section per cycle/sprint */}
          {cycleSections.map((section) => {
            const key = `cycle:${section.cycleId}`;
            const cycle = section.cycle;
            const subtitle = cycle ? formatCycleRange(cycle) : null;
            return (
              <BacklogSection
                key={key}
                sectionKey={key}
                title={cycle?.name ?? "Unknown sprint"}
                subtitle={subtitle}
                statusBadge={cycle?.status}
                count={section.items.length}
                collapsed={!!collapsed[key]}
                onToggle={() => toggleCollapsed(key)}
              >
                {section.items.map((item) => (
                  <BacklogRow
                    key={item.id}
                    item={item}
                    projectKey={projectKey}
                    member={item.assigneeId ? memberById.get(item.assigneeId) : undefined}
                    statusLabel={
                      columnMap.get(item.columnKey)?.name ?? prettifyKey(item.columnKey)
                    }
                    cycleName={cycle?.name ?? null}
                    done={isDone(item)}
                    menuGroups={buildMenuGroups(item)}
                    onOpen={() => openDetail(item)}
                  />
                ))}
              </BacklogSection>
            );
          })}
        </div>
      )}

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
        onDelete={(id) =>
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            (prev ?? []).filter((i) => i.id !== id),
          )
        }
        onDuplicate={(dupe) => {
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) => [...(prev ?? []), dupe]);
          setDetailItem(dupe);
          setDetailOpen(true);
        }}
      />
    </div>
  );
}

const CYCLE_STATUS_VARIANT: Record<Cycle["status"], BadgeVariant> = {
  ACTIVE: "progress",
  PLANNED: "neutral",
  COMPLETED: "done",
};

function BacklogSection({
  title,
  subtitle,
  statusBadge,
  count,
  collapsed,
  onToggle,
  children,
}: {
  sectionKey: string;
  title: string;
  subtitle: string | null;
  statusBadge?: Cycle["status"];
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)]">
      <button
        type="button"
        onClick={onToggle}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-[var(--surface)] px-4 py-2 text-left transition-colors hover:bg-[var(--surface)]/80"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
        )}
        <span className="text-sm font-semibold text-[var(--text)]">{title}</span>
        {statusBadge && (
          <Badge variant={CYCLE_STATUS_VARIANT[statusBadge]} className="text-[10px]">
            {prettifyKey(statusBadge)}
          </Badge>
        )}
        {subtitle && (
          <span className="text-xs text-[var(--text-muted)]">{subtitle}</span>
        )}
        <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--border)] px-1.5 text-[11px] font-medium text-[var(--text-muted)]">
          {count}
        </span>
      </button>
      {!collapsed && <div>{children}</div>}
    </section>
  );
}

/** Shared row presentation. `dragHandle` is rendered by the sortable wrapper. */
function RowContent({
  item,
  projectKey,
  member,
  statusLabel,
  cycleName,
  done,
  menuGroups,
  onOpen,
  dragHandle,
}: {
  item: WorkItem;
  projectKey: string;
  member: OrgMember | undefined;
  statusLabel: string;
  cycleName: string | null;
  done: boolean;
  menuGroups: ActionMenuGroup[];
  onOpen: () => void;
  dragHandle?: React.ReactNode;
}) {
  const assigneeName = member?.user?.displayName ?? null;
  return (
    <div
      className={cn(
        "group/action flex items-center gap-2 border-b border-[var(--border)]/60 px-2 py-2 transition-colors hover:bg-[var(--surface)]/60",
        done && "opacity-60",
      )}
    >
      {dragHandle ?? <span className="w-5 shrink-0" aria-hidden />}

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
          {projectKey}-{item.ticketNumber}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm text-[var(--text)]",
            done && "line-through",
          )}
        >
          {item.title}
        </span>
      </button>

      <Badge
        variant={PRIORITY_VARIANT[item.priority]}
        className="hidden shrink-0 text-[10px] sm:inline-flex"
      >
        {PRIORITY_LABEL[item.priority]}
      </Badge>

      {item.storyPoints != null && (
        <span
          className="hidden h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[var(--border)] px-1.5 text-[11px] font-medium text-[var(--text-muted)] md:inline-flex"
          title={`${item.storyPoints} story points`}
        >
          {item.storyPoints}
        </span>
      )}

      <span className="hidden w-28 shrink-0 truncate text-right text-xs text-[var(--text-muted)] lg:block">
        {statusLabel}
      </span>

      <span className="hidden w-28 shrink-0 truncate text-right text-xs text-[var(--text-muted)] xl:block">
        {cycleName ?? "Backlog"}
      </span>

      <div className="w-6 shrink-0" title={assigneeName ?? "Unassigned"}>
        {assigneeName ? (
          <Avatar size="sm">
            {member?.user?.avatarUrl && <AvatarImage src={member.user.avatarUrl} />}
            <AvatarFallback>{assigneeName.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">—</span>
        )}
      </div>

      <ActionMenu groups={menuGroups} triggerClassName="shrink-0">
        <span className="sr-only">Row actions for {item.title}</span>
      </ActionMenu>
    </div>
  );
}

/** Cycle-section row — no drag handle (re-rank lives in the Backlog section). */
function BacklogRow(props: Omit<Parameters<typeof RowContent>[0], "dragHandle">) {
  return <RowContent {...props} />;
}

/** Backlog-section row — draggable via dnd-kit sortable. */
function SortableRow(props: Omit<Parameters<typeof RowContent>[0], "dragHandle">) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "relative z-20 opacity-80 shadow-lg")}
    >
      <RowContent
        {...props}
        dragHandle={
          <button
            type="button"
            className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] active:cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        }
      />
    </div>
  );
}

function BacklogSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="ml-auto h-5 w-20" />
      </div>
      <div className="flex-1 space-y-1 p-4">
        <Skeleton className="h-8 w-40" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
