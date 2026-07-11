"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
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
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GripVertical, Plus, X, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
import {
  HOME_WIDGET_TYPES,
  HOME_WIDGET_LABELS,
  HOME_WIDGET_SOURCE,
  LIST_WIDGET_TYPES,
} from "@/lib/home/widgets";
import { HomeListWidget } from "./list-widget";

interface HomeWidget {
  id: string;
  type: string;
}

interface PortfolioProject {
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  overdueItems: number;
}

export function HomeDashboard({ orgId }: { orgId: string }) {
  const { can } = usePermissions();
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params.orgSlug;
  // Portfolio-backed widgets read /analytics/portfolio (ANALYTICS_READ);
  // without it that fetch 403s, so don't offer those widgets and show "—"
  // rather than a misleading 0 if one already exists.
  const canAnalytics = can(Permission.ANALYTICS_READ);

  const widgetsKey = useOrgQueryKey("home-widgets");
  const portfolioKey = useOrgQueryKey("home", "portfolio");
  const membersKey = useOrgQueryKey("home", "members");

  const widgetsQ = useQuery({
    queryKey: widgetsKey,
    queryFn: () =>
      jsonFetch<HomeWidget[]>(`/api/v1/orgs/${orgId}/home-widgets`),
  });
  const portfolioQ = useQuery({
    queryKey: portfolioKey,
    queryFn: () =>
      jsonFetch<PortfolioProject[]>(`/api/v1/orgs/${orgId}/analytics/portfolio`),
  });
  const membersQ = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<unknown[]>(`/api/v1/orgs/${orgId}/members`),
  });

  const addWidget = useOrgMutation<HomeWidget, Error, string>({
    mutationFn: (type) =>
      jsonFetch(`/api/v1/orgs/${orgId}/home-widgets`, {
        method: "POST",
        body: JSON.stringify({ type }),
      }),
    invalidate: [["home-widgets"]],
  });
  const removeWidget = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/home-widgets/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["home-widgets"]],
  });

  // Drag-to-arrange: PATCH the new id order, optimistically reflecting it in the
  // cache so the grid settles instantly, and rolling back if the save fails.
  const qc = useQueryClient();
  const reorderWidgets = useOrgMutation<
    unknown,
    Error,
    string[],
    { prev?: HomeWidget[] }
  >({
    mutationFn: (orderedIds) =>
      jsonFetch(`/api/v1/orgs/${orgId}/home-widgets`, {
        method: "PATCH",
        body: JSON.stringify({ orderedIds }),
      }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: widgetsKey });
      const prev = qc.getQueryData<HomeWidget[]>(widgetsKey);
      if (prev) {
        const byId = new Map(prev.map((w) => [w.id, w]));
        const reordered = orderedIds
          .map((id) => byId.get(id))
          .filter((w): w is HomeWidget => Boolean(w));
        qc.setQueryData(widgetsKey, reordered);
      }
      return { prev };
    },
    onError: (err, _vars, context) => {
      if (context?.prev) qc.setQueryData(widgetsKey, context.prev);
      notifyError(err);
    },
    invalidate: [["home-widgets"]],
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const widgets = widgetsQ.data ?? [];
  const portfolio = portfolioQ.data ?? [];
  const members = membersQ.data ?? [];
  const metricsLoading = portfolioQ.isLoading || membersQ.isLoading;

  function metricFor(type: string): number {
    const sum = (f: (p: PortfolioProject) => number) =>
      portfolio.reduce((acc, p) => acc + (f(p) || 0), 0);
    switch (type) {
      case "open_items":
        return sum((p) => p.totalItems - p.completedItems);
      case "in_progress_items":
        return sum((p) => p.inProgressItems);
      case "completed_items":
        return sum((p) => p.completedItems);
      case "overdue_items":
        return sum((p) => p.overdueItems);
      case "team_members":
        return members.length;
      default:
        return 0;
    }
  }

  const usedTypes = new Set(widgets.map((w) => w.type));
  const available = HOME_WIDGET_TYPES.filter(
    (w) =>
      !usedTypes.has(w.type) &&
      (w.source !== "portfolio" || canAnalytics),
  );

  const addMenu =
    available.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Plus className="h-4 w-4 mr-1" />
          Add widget
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {available.map((w) => (
            <DropdownMenuItem
              key={w.type}
              onClick={() => addWidget.mutate(w.type)}
            >
              {w.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  if (widgetsQ.isLoading) {
    // Match the slim empty-state height (the common, seed-default case) so the
    // project grid below doesn't shift when the query resolves to no widgets.
    return (
      <div className="mb-8 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4">
        <Skeleton className="h-5 w-64" />
      </div>
    );
  }

  // Empty state: a slim prompt so the page still leads with the project grid.
  if (widgets.length === 0) {
    return (
      <div className="mb-8 flex items-center justify-between rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4">
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <LayoutDashboard className="h-4 w-4" />
          Build your dashboard — pin the metrics you care about.
        </div>
        {addMenu}
      </div>
    );
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = widgets.findIndex((w) => w.id === active.id);
    const newIndex = widgets.findIndex((w) => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(widgets, oldIndex, newIndex);
    reorderWidgets.mutate(next.map((w) => w.id));
  }

  return (
    <div className="mb-10 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--text-muted)]">
          Your dashboard
        </h2>
        {addMenu}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={widgets.map((w) => w.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {widgets.map((w) => {
              const isList = LIST_WIDGET_TYPES.has(w.type);
              const source = HOME_WIDGET_SOURCE[w.type];
              const sourceErrored =
                source === "portfolio"
                  ? portfolioQ.isError
                  : source === "members"
                    ? membersQ.isError
                    : false;
              const label = HOME_WIDGET_LABELS[w.type] ?? w.type;
              return (
                <SortableWidget
                  key={w.id}
                  id={w.id}
                  label={label}
                  className={cn(isList && "sm:col-span-2 lg:col-span-1")}
                  onRemove={() => removeWidget.mutate(w.id)}
                >
                  {isList ? (
                    <HomeListWidget
                      orgId={orgId}
                      orgSlug={orgSlug}
                      type={w.type as "recent_activity" | "my_watched"}
                    />
                  ) : (
                    <StatCard label={label}>
                      {metricsLoading ? (
                        <Skeleton className="h-8 w-16" />
                      ) : sourceErrored ? (
                        // Don't show a misleading 0 when the metric source is
                        // unavailable (e.g. no ANALYTICS_READ).
                        <StatCard.Number>—</StatCard.Number>
                      ) : (
                        <StatCard.Number>{metricFor(w.type)}</StatCard.Number>
                      )}
                    </StatCard>
                  )}
                </SortableWidget>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/**
 * One draggable widget cell: renders the widget body plus a hover-revealed
 * control cluster (a drag handle to arrange, and a remove button). The card
 * itself isn't the drag target — only the handle is — so links/menus inside
 * list widgets stay clickable.
 */
function SortableWidget({
  id,
  label,
  className,
  onRemove,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/widget relative",
        isDragging && "z-20 opacity-80 shadow-[var(--shadow-glow)]",
        className,
      )}
    >
      {children}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/widget:opacity-100">
        <button
          type="button"
          aria-label={`Drag to reorder ${label} widget`}
          className="cursor-grab touch-none rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Remove ${label} widget`}
          onClick={onRemove}
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
