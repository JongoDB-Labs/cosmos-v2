/**
 * Drag resolution for the Backlog & Sprints planner (FR debd4e39 / task 2).
 *
 * The planner is a multi-container dnd-kit board: one "Backlog" container plus a
 * container per sprint/interval. Dragging a row can either REORDER it within its
 * container or REASSIGN it to another container (which changes the work item's
 * interval — dropping onto the backlog clears it). This pure helper turns a
 * (draggedId, overId, containers) triple into the intended move so the logic is
 * unit-testable without a live DnD surface.
 */

export const BACKLOG_CONTAINER = "__backlog__";

/** containerId → ordered work-item ids in that container (rank order). */
export type Containers = Record<string, string[]>;

export interface DragReorder {
  kind: "reorder";
  container: string;
  fromIndex: number;
  toIndex: number;
}
export interface DragReassign {
  kind: "reassign";
  itemId: string;
  /** Target interval id, or null when moving to the backlog. */
  toIntervalId: string | null;
  toIndex: number;
}
export type DragMove = DragReorder | DragReassign | null;

/** The minimum an interval must expose to be laid out as a planner section. */
export interface SectionInterval {
  id: string;
  status: "ACTIVE" | "PLANNED" | "COMPLETED";
  startDate?: string | null;
}

/** The minimum a work item must expose to be filed into a planner section. */
export interface SectionItem {
  id: string;
  intervalId?: string | null;
}

export interface IntervalSection<T, I> {
  /** The interval's id, or the orphan bucket's id when `interval` is null. */
  intervalId: string;
  /** Null when the item points at an interval the caller didn't supply. */
  interval: I | null;
  items: T[];
}

const STATUS_RANK: Record<SectionInterval["status"], number> = {
  ACTIVE: 0,
  PLANNED: 1,
  COMPLETED: 2,
};

/**
 * Lay the planner out as one section per interval, ordered (status, startDate).
 *
 * Every interval you can still plan into gets a section EVEN WHEN EMPTY. That
 * is the whole point: a section is what renders the droppable node, so deriving
 * sections from the items alone — as this used to — meant a sprint holding
 * nothing had no drop target, and an item could never be dragged into a
 * brand-new sprint. `resolveDrag` has always handled the empty-container drop
 * (it appends); the destination simply was never on screen.
 *
 * COMPLETED intervals are included only when they still hold items. You don't
 * plan into a finished sprint, and a permanent section for every sprint the
 * project ever ran would bury the live ones.
 *
 * Items pointing at an interval that isn't in `intervals` (stale cache, or one
 * the user can't read) keep an orphan section, sorted last — never dropped,
 * because a row that renders nowhere is a row the user has lost.
 */
export function buildIntervalSections<
  T extends SectionItem,
  I extends SectionInterval,
>(
  items: T[],
  intervals: I[],
  sortItems: (a: T, b: T) => number,
): IntervalSection<T, I>[] {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    if (item.intervalId == null) continue;
    const arr = grouped.get(item.intervalId);
    if (arr) arr.push(item);
    else grouped.set(item.intervalId, [item]);
  }

  const byId = new Map(intervals.map((c) => [c.id, c]));
  for (const c of intervals) {
    if (c.status !== "COMPLETED" && !grouped.has(c.id)) grouped.set(c.id, []);
  }

  return Array.from(grouped.entries())
    .map(([intervalId, secItems]) => ({
      interval: byId.get(intervalId) ?? null,
      intervalId,
      items: secItems.slice().sort(sortItems),
    }))
    .sort((a, b) => {
      if (a.interval && b.interval) {
        const sr = STATUS_RANK[a.interval.status] - STATUS_RANK[b.interval.status];
        if (sr !== 0) return sr;
        return (a.interval.startDate ?? "").localeCompare(b.interval.startDate ?? "");
      }
      if (a.interval) return -1;
      if (b.interval) return 1;
      return a.intervalId.localeCompare(b.intervalId);
    });
}

/** Which container holds `id`? `id` may be a container id itself, or an item id. */
export function findContainer(id: string, containers: Containers): string | null {
  if (Object.prototype.hasOwnProperty.call(containers, id)) return id;
  for (const cid of Object.keys(containers)) {
    if (containers[cid].includes(id)) return cid;
  }
  return null;
}

/**
 * Resolve a drag end into a concrete move. `overId` is either an item id (the
 * row dropped onto) or a container id (dropped onto an empty section / header).
 * Returns null when the drag is a no-op or can't be resolved.
 */
export function resolveDrag(
  activeId: string,
  overId: string | null | undefined,
  containers: Containers,
): DragMove {
  if (!overId) return null;
  const from = findContainer(activeId, containers);
  const to = findContainer(overId, containers);
  if (!from || !to) return null;

  const targetIds = containers[to];
  // Dropping on the container itself (empty section / header) appends;
  // dropping on a row inserts at that row's position.
  const overIsContainer = Object.prototype.hasOwnProperty.call(containers, overId);
  const overIndex = overIsContainer ? targetIds.length : targetIds.indexOf(overId);
  const toIndex = overIndex < 0 ? targetIds.length : overIndex;

  if (from === to) {
    const fromIndex = containers[from].indexOf(activeId);
    if (fromIndex < 0 || fromIndex === toIndex) return null;
    return { kind: "reorder", container: from, fromIndex, toIndex };
  }

  return {
    kind: "reassign",
    itemId: activeId,
    toIntervalId: to === BACKLOG_CONTAINER ? null : to,
    toIndex,
  };
}
