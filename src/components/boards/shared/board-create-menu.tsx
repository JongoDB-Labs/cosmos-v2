"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Plus, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { guardScroll } from "@/components/ui/action-menu";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { buildCreateBody } from "@/components/boards/shared/create-issue-button";
import {
  defaultBoardTypeId,
  createActionLabel,
  resolveTargetColumnKey,
} from "@/lib/boards/board-create";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import type { BoardColumn, WorkItem } from "@/types/models";

export interface BoardCreateMenuHandle {
  /**
   * Open the right-click create menu at a viewport point. Pass the column the
   * user right-clicked (or omit/null for the empty board background — the menu
   * then targets the board's first column). A no-op when the user lacks
   * ITEM_CREATE or the board has no columns to create into.
   */
  openAt: (x: number, y: number, columnKey?: string | null) => void;
}

interface BoardCreateMenuProps {
  orgId: string;
  projectId: string;
  /** The board's columns, pre-sorted by sortOrder (used for the status picker
   *  and to resolve the default target column). */
  columns: BoardColumn[];
  /** Called with the created item so the board can append it optimistically. */
  onCreated: (item: WorkItem) => void;
}

/**
 * COSMOS-88 — the shared "right-click a board to create the appropriate item"
 * affordance. A single hidden context menu (positioned at the cursor, mirroring
 * `data-table.tsx`'s trick) offers one create action defaulted to the board's
 * appropriate item type; selecting it opens a small create dialog pre-scoped to
 * the board and the right-clicked column (or the first column for a background
 * right-click). The board wires `openAt` to its own `onContextMenu` handlers.
 *
 * Rendered once per board and driven imperatively via a ref so a single menu +
 * dialog serves every column and the empty background alike.
 */
export const BoardCreateMenu = forwardRef<BoardCreateMenuHandle, BoardCreateMenuProps>(
  function BoardCreateMenu({ orgId, projectId, columns, onCreated }, ref) {
    const { can } = usePermissions();
    const canCreate = can(Permission.ITEM_CREATE);
    const { types: workItemTypes } = useWorkItemTypes(orgId);

    const [menuOpen, setMenuOpen] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [targetColumnKey, setTargetColumnKey] = useState("");
    const [title, setTitle] = useState("");
    const [workItemTypeId, setWorkItemTypeId] = useState("");
    const [columnKey, setColumnKey] = useState("");
    const [pending, setPending] = useState(false);

    // The hidden anchor the menu positions against — parked fixed in-viewport
    // when idle so base-ui's focus-restore on close never scrolls the board
    // (same rationale as data-table.tsx's context menu).
    const anchorRef = useRef<HTMLButtonElement>(null);

    const resetAnchor = useCallback(() => {
      const btn = anchorRef.current;
      if (btn) {
        Object.assign(btn.style, {
          position: "fixed",
          left: "0px",
          top: "0px",
          width: "1px",
          height: "1px",
          padding: "0",
          overflow: "hidden",
          pointerEvents: "none",
        });
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        openAt: (x, y, key) => {
          if (!canCreate) return;
          const resolved = resolveTargetColumnKey(columns, key);
          if (!resolved) return; // no columns → nothing to create into
          setTargetColumnKey(resolved);
          const btn = anchorRef.current;
          if (!btn) return;
          // Neutralize the focus-into-view scroll the menu open triggers.
          guardScroll(btn.parentElement);
          Object.assign(btn.style, {
            position: "fixed",
            left: `${x}px`,
            top: `${y}px`,
            width: "1px",
            height: "1px",
            padding: "0",
            overflow: "hidden",
            pointerEvents: "none",
          });
          btn.click();
        },
      }),
      [canCreate, columns],
    );

    // Seed / repair the create dialog's fields each time it opens (types may
    // still be loading when the menu first appears, so re-run when they land).
    useEffect(() => {
      if (!dialogOpen) return;
      setWorkItemTypeId((prev) =>
        prev && workItemTypes.some((t) => t.id === prev)
          ? prev
          : defaultBoardTypeId(workItemTypes),
      );
    }, [dialogOpen, workItemTypes]);

    function openDialog() {
      setColumnKey(targetColumnKey);
      setWorkItemTypeId(defaultBoardTypeId(workItemTypes));
      setTitle("");
      setDialogOpen(true);
    }

    async function handleCreate() {
      if (!title.trim() || !columnKey) return;
      setPending(true);
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              buildCreateBody({
                title,
                workItemTypeId,
                columnKey,
                priority: "MEDIUM",
                assigneeIds: [],
                cycleId: null,
                startDate: "",
                dueDate: "",
                tags: [],
              }),
            ),
          },
        );
        if (!res.ok) throw new Error(`Failed to create item (HTTP ${res.status})`);
        const item: WorkItem = await res.json();
        toast.success(`Created #${item.ticketNumber}`);
        onCreated(item);
        setDialogOpen(false);
        setTitle("");
      } catch (err) {
        notifyError(err, "Couldn't create the item.");
      } finally {
        setPending(false);
      }
    }

    // Users without create rights get no menu at all — the API gates POST on
    // ITEM_CREATE, so a menu for them would only 403 after a title is typed
    // (matches the per-column quick-create, which hides the same way).
    if (!canCreate) return null;

    const actionLabel = createActionLabel(workItemTypes);

    return (
      <>
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(o) => {
            setMenuOpen(o);
            if (!o) {
              resetAnchor();
              guardScroll(anchorRef.current?.parentElement ?? null, 45);
            }
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
                  left: 0,
                  top: 0,
                  width: 1,
                  height: 1,
                  pointerEvents: "none",
                }}
                className="opacity-0"
              />
            }
          />
          {/* positionMethod="fixed" mirrors base-ui's own ContextMenu so opening
              the menu can't scroll the board (see data-table.tsx). */}
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={2}
            positionMethod="fixed"
            className="min-w-[160px]"
          >
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                openDialog();
              }}
            >
              <Plus className="h-4 w-4" />
              {actionLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog
          open={dialogOpen}
          onOpenChange={(o) => {
            if (!o && !pending) setDialogOpen(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create item</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    title.trim() &&
                    columnKey &&
                    !pending
                  ) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder="Item title"
                disabled={pending}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  items={Object.fromEntries(
                    workItemTypes.map((t) => [t.id, t.name]),
                  )}
                  value={workItemTypeId}
                  onValueChange={(v) => v && setWorkItemTypeId(v as string)}
                  disabled={workItemTypes.length === 0}
                >
                  <SelectTrigger size="sm" aria-label="Item type" className="w-32 text-xs">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {workItemTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  items={Object.fromEntries(columns.map((c) => [c.key, c.name]))}
                  value={columnKey}
                  onValueChange={(v) => v && setColumnKey(v as string)}
                  disabled={columns.length === 0}
                >
                  <SelectTrigger size="sm" aria-label="Status" className="w-40 text-xs">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!title.trim() || !columnKey || pending}
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  },
);
