"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import type { KeyResult } from "@/types/models";
import { krProgressPercent } from "@/lib/okr/progress";
import { KeyResultCheckinDialog, RAG_META } from "./key-result-checkin-dialog";
import { KeyResultEditDialog } from "./key-result-edit-dialog";

interface KeyResultRowProps {
  keyResult: KeyResult;
  onUpdate: (id: string, currentValue: number) => void;
  orgId: string;
  projectId: string;
  /** Called after a successful check-in so the board refetches (progress + RAG). */
  onCheckedIn: () => void;
}

const statusLabels: Record<KeyResult["status"], string> = {
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  AT_RISK: "At Risk",
  ON_TRACK: "On Track",
  DONE: "Done",
};

const statusVariants: Record<KeyResult["status"], "neutral" | "progress" | "critical" | "done"> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "progress",
  AT_RISK: "critical",
  ON_TRACK: "done",
  DONE: "done",
};

function getProgressPercent(kr: KeyResult): number {
  return krProgressPercent(kr.startValue, kr.currentValue, kr.targetValue, kr.lowerIsBetter);
}

function getProgressColor(percent: number): string {
  if (percent < 30) return "bg-red-500";
  if (percent <= 70) return "bg-yellow-500";
  return "bg-green-500";
}

export function KeyResultRow({
  keyResult,
  onUpdate,
  orgId,
  projectId,
  onCheckedIn,
}: KeyResultRowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(keyResult.currentValue));
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const progress = getProgressPercent(keyResult);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/key-results/${keyResult.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to delete key result");
      setDeleteOpen(false);
      onCheckedIn();
    } catch (err) {
      console.error("Failed to delete key result:", err);
      notifyError(err, "Couldn't delete the key result.");
    } finally {
      setDeleting(false);
    }
  }

  function handleSave() {
    const num = parseFloat(editValue);
    if (!isNaN(num)) {
      // Fire celebrate() when a KR crosses into 100% completion as a result
      // of this update — once per crossing.
      const wasComplete = getProgressPercent(keyResult) >= 100;
      const willBeComplete =
        keyResult.targetValue === keyResult.startValue ||
        (keyResult.lowerIsBetter ? num <= keyResult.targetValue : num >= keyResult.targetValue);
      onUpdate(keyResult.id, num);
      if (!wasComplete && willBeComplete) {
        void import("@/lib/confetti").then(({ celebrate }) => celebrate());
      }
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setEditValue(String(keyResult.currentValue));
      setEditing(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-muted/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{keyResult.title}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", getProgressColor(progress))}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {progress}%
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {editing ? (
          <Input
            className="w-20 h-6 text-xs"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        ) : (
          <button
            onClick={() => {
              setEditValue(String(keyResult.currentValue));
              setEditing(true);
            }}
            className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors cursor-pointer"
            title="Click to edit"
          >
            {keyResult.currentValue} / {keyResult.targetValue}
            {keyResult.unit ? ` ${keyResult.unit}` : ""}
          </button>
        )}

        {keyResult.rag && (
          <span
            className="flex items-center gap-1"
            title={`${RAG_META[keyResult.rag].label}${
              keyResult.confidence != null ? ` · ${keyResult.confidence}% confidence` : ""
            }`}
          >
            <span className={cn("size-2.5 rounded-full", RAG_META[keyResult.rag].dot)} />
            {keyResult.confidence != null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {keyResult.confidence}%
              </span>
            )}
          </span>
        )}

        <button
          onClick={() => setCheckinOpen(true)}
          className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Check in
        </button>

        <Badge variant={statusVariants[keyResult.status]}>
          {statusLabels[keyResult.status]}
        </Badge>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" />}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <KeyResultCheckinDialog
        orgId={orgId}
        projectId={projectId}
        keyResult={keyResult}
        open={checkinOpen}
        onOpenChange={setCheckinOpen}
        onDone={onCheckedIn}
      />

      {editOpen && (
        <KeyResultEditDialog
          orgId={orgId}
          projectId={projectId}
          keyResult={keyResult}
          open
          onOpenChange={setEditOpen}
          onSaved={onCheckedIn}
        />
      )}

      <Dialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!deleting) setDeleteOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete key result?</DialogTitle>
            <DialogDescription>
              This permanently deletes &ldquo;{keyResult.title}&rdquo; and its check-in
              history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
