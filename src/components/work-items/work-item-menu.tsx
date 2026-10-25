"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelRightOpen, Trash2 } from "lucide-react";
import {
  ActionMenu,
  ActionRow,
  guardScroll,
  type ActionMenuGroup,
} from "@/components/ui/action-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteWorkItemDialog } from "@/components/work-items/delete-work-item-dialog";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { useOrgSlug } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { highlightMenuGroup } from "@/lib/work-items/highlight-menu";
import { archiveAction, copyLinkAction } from "@/lib/work-items/item-actions";
import type { WorkItem } from "@/types/models";

/** Just enough of a work item for its menu. */
export type MenuWorkItem = Pick<
  WorkItem,
  "id" | "orgId" | "projectId" | "title" | "highlight" | "archivedAt"
>;

interface MenuOptions {
  /** Opens the item's detail sheet. */
  onOpen: (id: string) => void;
  /** How the item is named, e.g. "FSC-7"; also the key its copied link uses. */
  ticketLabel: string;
}

/**
 * The menu every work-item surface without a richer one of its own offers
 * (COSMOS-211): the calendar, the roadmap and the Gantt.
 *
 * Gated like the Kanban and RAID cards (COSMOS-210): Open and Copy link for
 * anyone who can see the item, Highlight and Archive behind ITEM_UPDATE, and
 * Delete, with a confirm, behind ITEM_DELETE. The server checks the same
 * permissions on every write, so hiding a row only spares the user an action
 * that would fail.
 *
 * Every write invalidates `["work-items", projectId]`, the key all three views
 * read their items from, so the change shows without a reload (COSMOS-212).
 */
export function useWorkItemMenu(item: MenuWorkItem, { onOpen, ticketLabel }: MenuOptions) {
  const { can } = usePermissions();
  const canUpdate = can(Permission.ITEM_UPDATE);
  const canDelete = can(Permission.ITEM_DELETE);
  const orgSlug = useOrgSlug();
  const itemPath = `/api/v1/orgs/${item.orgId}/projects/${item.projectId}/work-items/${item.id}`;
  const invalidate = [["work-items", item.projectId]];

  // Drafts show a pick at once and drop back to the stored value on error,
  // as on the RAID card.
  const [highlightDraft, setHighlightDraft] = useState<string | null | undefined>(undefined);
  const highlight = highlightDraft === undefined ? item.highlight : highlightDraft;
  const highlightMutation = useOrgMutation<unknown, Error, string | null>({
    mutationFn: (next) =>
      jsonFetch(itemPath, { method: "PUT", body: JSON.stringify({ highlight: next }) }),
    invalidate,
    onError: (err) => {
      setHighlightDraft(undefined);
      notifyError(err, "Couldn't save the highlight.");
    },
  });

  const [archivedDraft, setArchivedDraft] = useState<string | null | undefined>(undefined);
  const archivedAt = archivedDraft === undefined ? item.archivedAt : archivedDraft;
  const archiveMutation = useOrgMutation<unknown, Error, string | null>({
    mutationFn: (next) =>
      jsonFetch(itemPath, { method: "PUT", body: JSON.stringify({ archivedAt: next }) }),
    invalidate,
    onError: (err) => {
      setArchivedDraft(undefined);
      notifyError(err, "Couldn't archive that item.");
    },
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useOrgMutation<unknown, Error, void>({
    mutationFn: () => jsonFetch(itemPath, { method: "DELETE" }),
    invalidate,
    onSuccess: () => setConfirmDelete(false),
    onError: (err) => notifyError(err, "Couldn't delete that item."),
  });

  const groups: ActionMenuGroup[] = [
    { items: [{ label: "Open", icon: PanelRightOpen, onClick: () => onOpen(item.id) }] },
    highlightMenuGroup({
      current: highlight,
      canEdit: canUpdate,
      disabled: highlightMutation.isPending,
      onPick: (next) => {
        setHighlightDraft(next);
        highlightMutation.mutate(next);
      },
    }),
    {
      items: [
        ...copyLinkAction({ id: item.id, ticketKey: ticketLabel }, orgSlug),
        ...archiveAction({
          item: { id: item.id, archivedAt },
          canEdit: canUpdate,
          pending: archiveMutation.isPending,
          onToggle: (next) => {
            setArchivedDraft(next);
            archiveMutation.mutate(next);
          },
        }),
      ],
    },
    {
      items: canDelete
        ? [
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive" as const,
              onClick: () => setConfirmDelete(true),
            },
          ]
        : [],
    },
  ];

  const dialog = (
    <DeleteWorkItemDialog
      open={confirmDelete}
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => deleteMutation.mutate()}
      pending={deleteMutation.isPending}
      ticketLabel={ticketLabel}
      title={item.title}
    />
  );

  return { groups, dialog, confirmingDelete: confirmDelete };
}

/**
 * Wraps an HTML item (a calendar entry, a roadmap card, a Gantt row label):
 * right-click opens the menu, and a ⋯ button that shows on hover or focus
 * opens it from the keyboard.
 */
export function WorkItemMenu({
  item,
  onOpen,
  ticketLabel,
  triggerClassName,
  children,
}: MenuOptions & {
  item: MenuWorkItem;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const { groups, dialog } = useWorkItemMenu(item, { onOpen, ticketLabel });
  return (
    <>
      <ActionMenu
        groups={groups}
        triggerLabel={`Actions for ${ticketLabel}`}
        triggerClassName={triggerClassName}
      >
        {children}
      </ActionMenu>
      {dialog}
    </>
  );
}

/**
 * The same menu opened at a point, for an item drawn in SVG (a Gantt bar),
 * where `WorkItemMenu`'s wrapper and button can't go. Mount it on the
 * right-click with the cursor position; it opens at once and calls `onClose`
 * when the menu, and any delete confirm it led to, is done.
 */
export function WorkItemMenuAt({
  item,
  at,
  onOpen,
  ticketLabel,
  onClose,
}: MenuOptions & {
  item: MenuWorkItem;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const { groups, dialog, confirmingDelete } = useWorkItemMenu(item, { onOpen, ticketLabel });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Closing the menu to show the delete confirm must not unmount the confirm.
  const [menuDone, setMenuDone] = useState(false);

  useEffect(() => {
    const btn = anchorRef.current;
    if (!btn) return;
    guardScroll(btn.parentElement);
    btn.click();
  }, []);

  useEffect(() => {
    if (menuDone && !confirmingDelete) onClose();
  }, [menuDone, confirmingDelete, onClose]);

  const visible = groups.filter((g) => g.items.length > 0);

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setMenuDone(true);
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              ref={anchorRef}
              type="button"
              aria-hidden
              tabIndex={-1}
              style={{
                position: "fixed",
                left: at.x,
                top: at.y,
                width: 1,
                height: 1,
                padding: 0,
                overflow: "hidden",
                pointerEvents: "none",
              }}
              className="opacity-0"
            />
          }
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={2}
          positionMethod="fixed"
          className="min-w-[160px]"
        >
          {visible.map((group, gi) => (
            <DropdownMenuGroup key={group.label ?? gi}>
              {gi > 0 && <DropdownMenuSeparator />}
              {group.label && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
              {group.items.map((row) => (
                <ActionRow key={row.label} item={row} onDone={() => setOpen(false)} />
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
