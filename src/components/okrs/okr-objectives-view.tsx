"use client";

import { useMemo, useState } from "react";
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
import { GripVertical, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ObjectiveCard } from "./objective-card";
import type { Objective } from "@/types/models";

type StatusFilter = "all" | Objective["status"];
type SortBy = "manual" | "progress-desc" | "progress-asc" | "az" | "health";
type Rag = "GREEN" | "YELLOW" | "RED";

interface OkrObjectivesViewProps {
  orgId: string;
  projectId: string;
  objectives: Objective[];
  onEdit: (objective: Objective) => void;
  onDelete: (objectiveId: string) => void;
  onAddKeyResult: (objectiveId: string, title: string) => void | Promise<void>;
  onUpdateKeyResult: (krId: string, currentValue: number) => void;
  onCheckedIn: () => void;
  /** Persist a manual drag reorder (indices into the current objectives array). */
  onReorder: (oldIndex: number, newIndex: number) => void;
}

const RAG_SEVERITY: Record<Rag, number> = { GREEN: 1, YELLOW: 2, RED: 3 };

/** An objective's rolled-up health = the worst RAG among its key results. */
function objectiveRag(o: Objective): Rag | null {
  let worst: Rag | null = null;
  for (const kr of o.keyResults ?? []) {
    const rag = kr.rag as Rag | null;
    if (rag && (worst === null || RAG_SEVERITY[rag] > RAG_SEVERITY[worst])) worst = rag;
  }
  return worst;
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "manual", label: "Manual order" },
  { value: "progress-desc", label: "Progress (high → low)" },
  { value: "progress-asc", label: "Progress (low → high)" },
  { value: "health", label: "Health (worst first)" },
  { value: "az", label: "Title (A → Z)" },
];

const selectCls =
  "h-9 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm text-[var(--text)]";

export function OkrObjectivesView({
  orgId,
  projectId,
  objectives,
  onEdit,
  onDelete,
  onAddKeyResult,
  onUpdateKeyResult,
  onCheckedIn,
  onReorder,
}: OkrObjectivesViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("manual");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const query = search.trim().toLowerCase();

  const displayed = useMemo(() => {
    let list = objectives;
    if (statusFilter !== "all") list = list.filter((o) => o.status === statusFilter);
    if (query) {
      list = list.filter(
        (o) =>
          o.title.toLowerCase().includes(query) ||
          (o.description ?? "").toLowerCase().includes(query),
      );
    }
    // Sort is applied on a copy so the underlying (manual) order is preserved.
    const sorted = [...list];
    switch (sortBy) {
      case "progress-desc":
        sorted.sort((a, b) => b.progress - a.progress);
        break;
      case "progress-asc":
        sorted.sort((a, b) => a.progress - b.progress);
        break;
      case "az":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "health":
        sorted.sort(
          (a, b) =>
            (objectiveRag(b) ? RAG_SEVERITY[objectiveRag(b)!] : 0) -
            (objectiveRag(a) ? RAG_SEVERITY[objectiveRag(a)!] : 0),
        );
        break;
      // "manual" keeps the filtered order (which follows objectives' sortOrder).
    }
    return sorted;
  }, [objectives, statusFilter, query, sortBy]);

  // Drag-to-reorder is only coherent when the on-screen order IS the manual order:
  // no search, no status filter, sort = manual. Otherwise the handles are hidden.
  const canReorder = sortBy === "manual" && !query && statusFilter === "all";

  const summary = useMemo(() => {
    const counts = { red: 0, yellow: 0, green: 0, none: 0 };
    let progressSum = 0;
    for (const o of displayed) {
      progressSum += o.progress;
      const rag = objectiveRag(o);
      if (rag === "RED") counts.red++;
      else if (rag === "YELLOW") counts.yellow++;
      else if (rag === "GREEN") counts.green++;
      else counts.none++;
    }
    const avg = displayed.length ? Math.round(progressSum / displayed.length) : 0;
    return { ...counts, avg };
  }, [displayed]);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = objectives.findIndex((o) => o.id === active.id);
    const newIndex = objectives.findIndex((o) => o.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(oldIndex, newIndex);
  }

  const cardProps = {
    orgId,
    projectId,
    onEdit,
    onDelete,
    onAddKeyResult,
    onUpdateKeyResult,
    onCheckedIn,
  };

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search objectives…"
            className="h-9 pl-8"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className={selectCls}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className={selectCls}
          aria-label="Sort objectives"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-[var(--text-muted)]">
        <span>
          <span className="font-medium text-[var(--text)]">{displayed.length}</span>
          {displayed.length === 1 ? " objective" : " objectives"}
          {displayed.length !== objectives.length && ` of ${objectives.length}`}
        </span>
        <span>
          avg <span className="font-medium text-[var(--text)] tabular-nums">{summary.avg}%</span>
        </span>
        <span className="flex items-center gap-3">
          <Dot cls="bg-green-500" n={summary.green} />
          <Dot cls="bg-yellow-500" n={summary.yellow} />
          <Dot cls="bg-red-500" n={summary.red} />
          {summary.none > 0 && <Dot cls="bg-[var(--border)]" n={summary.none} />}
        </span>
      </div>

      {displayed.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--text-muted)]">
          No objectives match your search or filter.
        </p>
      ) : canReorder ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={displayed.map((o) => o.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {displayed.map((objective) => (
                <SortableObjective key={objective.id} objective={objective} {...cardProps} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="space-y-3">
          {displayed.map((objective) => (
            <ObjectiveCard key={objective.id} objective={objective} {...cardProps} />
          ))}
        </div>
      )}
    </div>
  );
}

function Dot({ cls, n }: { cls: string; n: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("size-2.5 rounded-full", cls)} />
      <span className="tabular-nums">{n}</span>
    </span>
  );
}

function SortableObjective({
  objective,
  ...cardProps
}: {
  objective: Objective;
} & Omit<Parameters<typeof ObjectiveCard>[0], "objective" | "dragHandle">) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: objective.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "relative z-20 opacity-80 shadow-lg")}
    >
      <ObjectiveCard
        objective={objective}
        {...cardProps}
        dragHandle={
          <button
            type="button"
            className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] active:cursor-grabbing"
            aria-label="Drag to reorder"
            onClick={(e) => e.stopPropagation()}
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
