"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { KanbanCard } from "./kanban-card";
import type { BoardColumn, WorkItem, OrgMember } from "@/types/models";

interface KanbanColumnProps {
  column: BoardColumn;
  items: WorkItem[];
  members: OrgMember[];
  onCardClick: (item: WorkItem) => void;
  /**
   * Droppable id for this column. Defaults to `column.key` (legacy / flat
   * board). In swimlane mode the board passes a composite `${laneId}::${key}`
   * so each (lane, column) is its own droppable (dnd-kit requires unique
   * droppable ids) — the board's drag handlers strip the lane prefix back to
   * the column key, so a drop still only changes the card's columnKey/status.
   */
  droppableId?: string;
  /** Bulk-select mode (threaded to each card). */
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onCtrlSelect?: (id: string) => void;
  onRangeSelect?: (id: string) => void;
}

export function KanbanColumn({
  column,
  items,
  members,
  onCardClick,
  droppableId,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  onCtrlSelect,
  onRangeSelect,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId ?? column.key });

  const count = items.length;
  // `overWip` is the existing red over-limit state. `atWip` (exactly at the
  // limit) gets an amber pre-warning so a user can see they're about to hit the
  // WIP ceiling before the drop is rejected/warned in handleDragEnd.
  const overWip = column.wipLimit != null && count > column.wipLimit;
  const atWip = column.wipLimit != null && count === column.wipLimit;

  return (
    <div
      className={cn(
        // Near-full-width columns on phones (with a peek of the next), w-72 at
        // sm+. Avoids the 288px-on-375px unusable horizontal scroll.
        "flex w-[84vw] max-w-[19rem] shrink-0 flex-col rounded-lg bg-muted/30 border sm:w-72",
        isOver && "ring-2 ring-primary/30",
        isOver && overWip && "ring-red-500/50"
      )}
    >
      {/* Color bar */}
      <div
        className="h-1 rounded-t-lg"
        style={{ backgroundColor: column.color }}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{column.name}</h3>
          <span
            title={
              column.wipLimit != null
                ? `${count} of ${column.wipLimit} (WIP limit)`
                : undefined
            }
            className={cn(
              "inline-flex items-center justify-center rounded-full px-1.5 text-[11px] font-medium min-w-[20px] h-5",
              overWip
                ? "bg-red-500/20 text-red-400"
                : atWip
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-muted text-muted-foreground"
            )}
          >
            {count}
            {column.wipLimit != null && `/${column.wipLimit}`}
          </span>
        </div>
      </div>

      {/* Items */}
      <div
        ref={setNodeRef}
        // The DROPPABLE body, not the header — a drag has to land here.
        data-testid={`kanban-column-${column.key}`}
        className="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-[60px]"
      >
        <SortableContext
          items={items.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((item) => (
            <KanbanCard
              key={item.id}
              item={item}
              onClick={onCardClick}
              members={members}
              selectMode={selectMode}
              selected={selectedIds?.has(item.id) ?? false}
              onToggleSelect={onToggleSelect}
              onCtrlSelect={onCtrlSelect}
              onRangeSelect={onRangeSelect}
            />
          ))}
        </SortableContext>

        {items.length === 0 && (
          <div className="flex items-center justify-center py-8 text-center text-xs text-muted-foreground">
            No items
          </div>
        )}
      </div>

    </div>
  );
}
