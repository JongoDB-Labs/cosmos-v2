"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The one "Delete work item?" confirmation. The Kanban card, the detail sheet
 * and the Backlog row menu each carried a copy, so the wording and the
 * disabled-while-deleting state could drift between them.
 */
export function DeleteWorkItemDialog({
  open,
  onCancel,
  onConfirm,
  pending,
  ticketLabel,
  title,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  /** How the item is named in the sentence, e.g. "FSC-7" or "#7". */
  ticketLabel: string;
  title?: string | null;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        // Opened from inside draggable / clickable rows and cards: keep the
        // dialog's own clicks and keys from bubbling back into their handlers.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Delete work item?</DialogTitle>
          <DialogDescription>
            This will permanently delete {ticketLabel}
            {title ? ` "${title}"` : ""}. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
