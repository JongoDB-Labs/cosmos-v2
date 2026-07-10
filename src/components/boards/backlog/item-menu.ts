import { Copy, Eye, Inbox, MoveRight, Pencil, Trash2 } from "lucide-react";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import { Permission } from "@/lib/rbac/permissions";
import type { Cycle, WorkItem } from "@/types/models";

export interface BacklogItemMenuHandlers {
  /** Open the item's detail sheet (read + inline edit). */
  onOpen: () => void;
  /** Duplicate the item (creates a "Copy of …" sibling). */
  onDuplicate: () => void;
  /** Request delete — opens a confirm dialog before the destructive call. */
  onDelete: () => void;
  /** Move the item to a cycle, or null to send it back to the backlog. */
  onMoveToCycle: (cycleId: string | null) => void;
}

/**
 * Build the right-click / ⋯ context menu for a backlog row (COSMOS-29). Each
 * CRUD verb is gated by the actor's effective permissions so unauthorized
 * actions are simply absent from the menu:
 *   - Read/Update → a single "detail sheet" entry whose label reflects whether
 *     the actor may edit (ITEM_UPDATE) or only view (ITEM_READ).
 *   - Update      → "Move to sprint" (mutates cycleId), gated by ITEM_UPDATE.
 *   - Create      → "Duplicate", gated by ITEM_CREATE.
 *   - Delete      → "Delete" (destructive), gated by ITEM_DELETE.
 *
 * Pure + exported so the RBAC gating is exhaustively unit-testable without
 * driving base-ui in jsdom, mirroring the kanban card's menu so items behave
 * consistently across boards. The client `can()` is a role-only UX
 * approximation; every work-item route re-checks via `requireAccess`, so a
 * hidden/disabled action is never the only thing blocking an unauthorized write.
 */
export function buildBacklogItemMenu(
  item: WorkItem,
  cycles: Cycle[],
  can: (perm: bigint) => boolean,
  handlers: BacklogItemMenuHandlers,
): ActionMenuGroup[] {
  const canRead = can(Permission.ITEM_READ);
  const canUpdate = can(Permission.ITEM_UPDATE);
  const canCreate = can(Permission.ITEM_CREATE);
  const canDelete = can(Permission.ITEM_DELETE);

  // Read + Update entry point. Both open the same detail sheet, so a single
  // entry carries a label/icon that reflects whether the actor may edit or view.
  const openGroup: ActionMenuGroup = {
    items: canRead
      ? [
          {
            label: canUpdate ? "Edit details" : "View details",
            icon: canUpdate ? Pencil : Eye,
            onClick: handlers.onOpen,
          },
        ]
      : [],
  };

  // "Move to sprint" mutates cycleId — an update. Offer "Backlog" only when the
  // item currently sits in a cycle, and never list the item's current cycle.
  const moveGroup: ActionMenuGroup = {
    label: "Move to sprint",
    items: canUpdate
      ? [
          ...(item.cycleId != null
            ? [{ label: "Backlog", icon: Inbox, onClick: () => handlers.onMoveToCycle(null) }]
            : []),
          ...cycles
            .filter((c) => c.id !== item.cycleId)
            .map((c) => ({
              label: c.name,
              icon: MoveRight,
              onClick: () => handlers.onMoveToCycle(c.id),
            })),
        ]
      : [],
  };

  const createGroup: ActionMenuGroup = {
    items: canCreate
      ? [{ label: "Duplicate", icon: Copy, onClick: handlers.onDuplicate }]
      : [],
  };

  const destructiveGroup: ActionMenuGroup = {
    items: canDelete
      ? [
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive" as const,
            onClick: handlers.onDelete,
          },
        ]
      : [],
  };

  return [openGroup, moveGroup, createGroup, destructiveGroup];
}
