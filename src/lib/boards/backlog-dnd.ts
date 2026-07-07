/**
 * Drag resolution for the Backlog & Sprints planner (FR debd4e39 / task 2).
 *
 * The planner is a multi-container dnd-kit board: one "Backlog" container plus a
 * container per sprint/cycle. Dragging a row can either REORDER it within its
 * container or REASSIGN it to another container (which changes the work item's
 * cycle — dropping onto the backlog clears it). This pure helper turns a
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
  /** Target cycle id, or null when moving to the backlog. */
  toCycleId: string | null;
  toIndex: number;
}
export type DragMove = DragReorder | DragReassign | null;

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
    toCycleId: to === BACKLOG_CONTAINER ? null : to,
    toIndex,
  };
}
