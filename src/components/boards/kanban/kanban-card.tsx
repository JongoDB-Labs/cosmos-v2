"use client";

import { useMemo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { activateOnKey } from "@/lib/a11y/keyboard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import type { WorkItem, OrgMember } from "@/types/models";

interface KanbanCardProps {
  item: WorkItem;
  onClick: (item: WorkItem) => void;
  members: OrgMember[];
  /** Bulk-select mode: the card becomes a checkbox toggle (drag disabled). */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Ctrl/Cmd-click a card (when NOT already in select mode) → enter select
   *  mode with this card selected (FR: "hold ctrl/cmd to select cards"). */
  onCtrlSelect?: (id: string) => void;
  /** Shift-click a card → select the contiguous range from the anchor to this
   *  card (enters select mode if needed). COSMOS-39. */
  onRangeSelect?: (id: string) => void;
}

type Priority = WorkItem["priority"];

const priorityDot: Record<string, string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-green-500",
};

// Highest → lowest, matching the Prisma `Priority` enum.
const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const priorityLabel: Record<Priority, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export function KanbanCard({
  item,
  onClick,
  members,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onCtrlSelect,
  onRangeSelect,
}: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const { can } = usePermissions();

  const [confirmDelete, setConfirmDelete] = useState(false);

  const basePath = `/api/v1/orgs/${item.orgId}/projects/${item.projectId}/work-items/${item.id}`;

  // Invalidate the project's work-items cache so React-Query-backed board
  // views (table, timeline, dashboard) re-fetch. The kanban board itself
  // holds items in local state, so it picks up changes on its next mount.
  const invalidate = useMemo(() => [["work-items", item.projectId]], [item.projectId]);

  const priorityMutation = useOrgMutation<unknown, Error, Priority>({
    mutationFn: (priority) =>
      jsonFetch(basePath, {
        method: "PUT",
        body: JSON.stringify({ priority }),
      }),
    invalidate,
  });

  const deleteMutation = useOrgMutation<unknown, Error, void>({
    mutationFn: () => jsonFetch(basePath, { method: "DELETE" }),
    invalidate,
    onSuccess: () => setConfirmDelete(false),
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const assignee = item.assigneeId
    ? members.find((m) => m.userId === item.assigneeId)
    : null;

  const projectKey =
    (item.customFields?.projectKey as string | undefined) ??
    ((item as unknown as Record<string, unknown>).projectKey as
      | string
      | undefined) ??
    "";

  const ticketLabel = projectKey
    ? `${projectKey}-${item.ticketNumber}`
    : `#${item.ticketNumber}`;

  const menuGroups = useMemo<ActionMenuGroup[]>(() => {
    const canUpdate = can(Permission.ITEM_UPDATE);

    const editGroup: ActionMenuGroup = {
      items: [
        ...(canUpdate
          ? [
              {
                label: "Edit",
                icon: Pencil,
                onClick: () => onClick(item),
              },
            ]
          : []),
      ],
    };

    // Priority is a non-destructive update, so render the four levels inline
    // as a labeled group instead of a confirmation dialog. The current
    // priority is disabled and check-marked.
    const priorityGroup: ActionMenuGroup = {
      label: "Priority",
      items: canUpdate
        ? PRIORITIES.map((p) => ({
            label: priorityLabel[p],
            icon: p === item.priority ? Check : undefined,
            disabled: p === item.priority || priorityMutation.isPending,
            onClick: () => priorityMutation.mutate(p),
          }))
        : [],
    };

    const destructiveGroup: ActionMenuGroup = {
      items: can(Permission.ITEM_DELETE)
        ? [
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive" as const,
              onClick: () => setConfirmDelete(true),
            },
          ]
        : [],
    };

    return [editGroup, priorityGroup, destructiveGroup];
  }, [can, item, onClick, priorityMutation]);

  return (
    <>
      <ActionMenu groups={menuGroups}>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        // In select mode the card is a checkbox toggle, NOT a draggable — omit
        // the drag listeners so a tap selects instead of starting a drag (the
        // board also disables the DndContext sensors in select mode).
        {...(selectMode ? {} : listeners)}
        aria-label={
          selectMode
            ? `${selected ? "Deselect" : "Select"} ${ticketLabel}: ${item.title}`
            : `Open ${ticketLabel}: ${item.title}`
        }
        // No KeyboardSensor is configured, so suppress dnd-kit's injected
        // "press space to pick up the draggable item" instruction — it is
        // non-functional and contradicts the Enter/Space-to-open behavior.
        aria-describedby={undefined}
        aria-pressed={selectMode ? selected : undefined}
        onClick={(e) => {
          // Shift-click always takes the range path (in or out of select mode)
          // so it never falls through to opening the detail sheet.
          if (e.shiftKey && onRangeSelect) return onRangeSelect(item.id);
          if (selectMode) return onToggleSelect?.(item.id);
          if ((e.metaKey || e.ctrlKey) && onCtrlSelect)
            return onCtrlSelect(item.id);
          onClick(item);
        }}
        // dnd-kit's attributes make the card focusable (role=button, tabIndex=0)
        // but no KeyboardSensor is configured, so Enter/Space are free to open
        // the detail. Placed after {...listeners} so it isn't overridden.
        onKeyDown={activateOnKey(() =>
          selectMode ? onToggleSelect?.(item.id) : onClick(item),
        )}
        className={cn(
          "group/action relative rounded-lg border bg-card p-3 transition-colors",
          selectMode
            ? "cursor-pointer pl-8"
            : "cursor-grab active:cursor-grabbing",
          "hover:border-primary/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "border-primary ring-2 ring-primary/40 bg-primary/5",
          isDragging && "opacity-50 shadow-lg ring-2 ring-primary/20"
        )}
      >
        {selectMode && (
          <span
            aria-hidden
            className={cn(
              "absolute left-2.5 top-3 flex h-4 w-4 items-center justify-center rounded border",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background",
            )}
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        )}
        <div className="flex items-start gap-2 mb-2">
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">
            {ticketLabel}
          </span>
          <h4 className="text-sm font-medium leading-snug line-clamp-2 flex-1">
            {item.title}
          </h4>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
            >
              {item.workItemType?.name ?? "Item"}
            </span>

            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full shrink-0",
                priorityDot[item.priority] ?? priorityDot.MEDIUM
              )}
              title={item.priority}
            />

            {item.storyPoints != null && (
              <span className="inline-flex items-center justify-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {item.storyPoints}
              </span>
            )}
          </div>

          {assignee && (
            <div className="flex items-center -space-x-1.5">
              <Avatar size="sm" title={assignee.user?.displayName}>
                {assignee.user?.avatarUrl && (
                  <AvatarImage src={assignee.user.avatarUrl} />
                )}
                <AvatarFallback>
                  {(assignee.user?.displayName ?? "?").charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {/* Multi-assign: surface extra assignees as a +N chip. */}
              {(item.assignees?.length ?? 0) > 1 && (
                <span
                  className="z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground ring-1 ring-[var(--surface)]"
                  title={item.assignees
                    ?.filter((a) => a.userId !== item.assigneeId)
                    .map((a) => a.user?.displayName ?? "?")
                    .join(", ")}
                >
                  +{(item.assignees?.length ?? 1) - 1}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      </ActionMenu>

      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
      >
        <DialogContent
          // The card is a draggable button; keep dialog interactions from
          // bubbling up and re-triggering its open/drag handlers.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Delete work item?</DialogTitle>
            <DialogDescription>
              This will permanently delete {ticketLabel}
              {item.title ? ` "${item.title}"` : ""}. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
