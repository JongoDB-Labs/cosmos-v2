"use client";

import { useEffect, useState } from "react";
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
import { Plus, Loader2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import type { WorkItem, BoardColumn } from "@/types/models";

/**
 * Pick the default type to preselect: the project's "task" type if present
 * (built-in keys end with `.task`), else the first type. Returns "" while the
 * list is still loading/empty.
 */
function defaultTypeId(types: { id: string; key: string }[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
}

/**
 * A self-contained "+ New issue" affordance for the board views that lack
 * per-column quick-create (table, backlog, timeline, calendar, RAID) and the
 * org-wide Issues view. Opens a small dialog (title + type + status) and POSTs
 * to the work-items create endpoint; the status options are the board's own
 * columns, fetched on open so the caller only has to pass boardId. The caller's
 * onCreated refreshes its view (e.g. invalidate the work-items query).
 */
export function CreateIssueButton({
  orgId,
  projectId,
  boardId,
  onCreated,
  label = "New issue",
  variant = "outline",
}: {
  orgId: string;
  projectId: string;
  boardId: string;
  onCreated: (item: WorkItem) => void;
  label?: string;
  variant?: "outline" | "default" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [title, setTitle] = useState("");
  const [workItemTypeId, setWorkItemTypeId] = useState("");
  const [columnKey, setColumnKey] = useState("");
  const [pending, setPending] = useState(false);
  const [loadingCols, setLoadingCols] = useState(false);
  // The org's ACTUAL types (built-ins + custom). We submit the selected type's
  // id so a custom type (bare key like "feature") resolves — sending the bare
  // `type` string would make the server build a sector-prefixed key that misses.
  const { types: workItemTypes } = useWorkItemTypes(orgId);

  // Default / repair the Type selection once the types load while the dialog is
  // open (openDialog seeds it eagerly, but the list may still be in flight).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
  }, [open, workItemTypes]);

  async function openDialog() {
    setOpen(true);
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
    setLoadingCols(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${boardId}`,
      );
      if (res.ok) {
        const board = await res.json();
        const cols: BoardColumn[] = (board.columns ?? []).sort(
          (a: BoardColumn, b: BoardColumn) => a.sortOrder - b.sortOrder,
        );
        setColumns(cols);
        setColumnKey((prev) => prev || cols[0]?.key || "");
      }
    } catch {
      /* leave columns empty — the create button stays disabled until one loads */
    } finally {
      setLoadingCols(false);
    }
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
          // Fall back to the bare "TASK" type if the async types fetch hasn't
          // resolved yet, so creation never silently no-ops.
          body: JSON.stringify({ title: title.trim(), ...(workItemTypeId ? { workItemTypeId } : { type: "TASK" }), columnKey }),
        },
      );
      if (!res.ok) throw new Error(`Failed to create issue (HTTP ${res.status})`);
      const item: WorkItem = await res.json();
      toast.success(`Created #${item.ticketNumber}`);
      onCreated(item);
      setTitle("");
      setWorkItemTypeId(defaultTypeId(workItemTypes));
      setOpen(false);
    } catch (err) {
      notifyError(err, "Couldn't create the issue.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button size="sm" variant={variant} className="gap-1.5" onClick={openDialog}>
        <Plus className="h-3.5 w-3.5" />
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) setOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
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
                  workItemTypeId &&
                  !pending
                ) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="Issue title"
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
                <SelectTrigger size="sm" aria-label="Issue type" className="w-32 text-xs">
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
                disabled={loadingCols || columns.length === 0}
              >
                <SelectTrigger size="sm" aria-label="Status" className="w-40 text-xs">
                  <SelectValue placeholder={loadingCols ? "Loading…" : "Status"} />
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
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!title.trim() || !columnKey || pending}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
